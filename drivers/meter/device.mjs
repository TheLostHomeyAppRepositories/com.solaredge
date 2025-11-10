import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceMeter extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

    const { siteId } = this.getData();

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({ siteId });

    // Consumption
    if (sitePowerflow.consumption?.currentPower === null) {
      await this.setCapabilityValue('measure_power', 0).catch(this.error);
    } else if (typeof sitePowerflow.consumption?.currentPower === 'number') {
      // TODO: Maybe use sitePowerflow.consumption.isConsuming to flip the sign?
      await this.setCapabilityValue('measure_power', Math.round(sitePowerflow.consumption.currentPower * 1000)).catch(this.error);
    }

    // Grid
    if (typeof sitePowerflow.grid?.currentPower === 'number') {
      if (!this.hasCapability('measure_power.grid')) {
        await this.addCapability('measure_power.grid');
      }

      let power = Math.round(sitePowerflow.grid.currentPower * 1000);
      if (sitePowerflow.grid?.status === 'export') {
        power *= -1;
      }

      await this.setCapabilityValue('measure_power.grid', power).catch(this.error);
    }

    // Solar
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      if (!this.hasCapability('measure_power.solar')) {
        await this.addCapability('measure_power.solar');
      }

      let power = Math.round(sitePowerflow.solarProduction.currentPower * 1000);
      if (sitePowerflow.solarProduction?.isProducing === false) {
        power *= -1;
      }

      await this.setCapabilityValue('measure_power.solar', power).catch(this.error);
    }

    // Set Device Availability
    if (sitePowerflow.consumption?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    // Get measurements for each previous year. This can take a while, so we ensure we only do it once at a time.
    if (!this.getTotalPromise) {
      this.getTotalPromise = Promise.resolve().then(async () => {
        const measurements = {
          // [year]: {
          //   imported: 0,
          //   exported: 0,
          // },
          // [year]: 'missing', // No more data for this year
          // [year]: 'error', // Error fetching data for this year
        };

        const currentYear = new Date().getFullYear();
        let previousYear = currentYear;

        while (true) {
          previousYear--;

          measurements[previousYear] = await this.getStoreValue(`measurements-${previousYear}`);

          // If the value is missing, we need to fetch & store it
          if (measurements[previousYear] === null || measurements[previousYear] === 'error') {
            this.log(`Fetching measurements for ${previousYear}...`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Prevent Rate limit
            await this.api.getSiteMeasurements({
              siteId,
              startDate: `${previousYear}-01-01`,
              endDate: `${previousYear}-12-31`,
            })
              .then(async result => {
                if (!result.summary) {
                  throw new Error('empty_summary');
                }

                measurements[previousYear] = {
                  imported: result.summary.import,
                  exported: result.summary.export,
                };
                await this.setStoreValue(`measurements-${previousYear}`, measurements[previousYear]);
              })
              .catch(async err => {
                // If there's no data for this year, so we return null
                if (err.message.includes('INVALID_ARGUMENTS') || err.message.includes('empty_summary')) {
                  this.log(`No more data for ${previousYear}`);
                  measurements[previousYear] = 'missing';
                  await this.setStoreValue(`measurements-${previousYear}`, measurements[previousYear]);
                  return;
                }

                // Next time we try to fetch the data, we will retry.
                this.error(`Error fetching measurements for ${previousYear}: ${err.message}`);
                measurements[previousYear] = 'error';
                await this.setStoreValue(`measurements-${previousYear}`, measurements[previousYear]);
              });
          }

          if (measurements[previousYear] === 'missing') {
            break; // There's no more data.
          }

          if (measurements[previousYear] === 'error') {
            continue; // Skip this year. We will try again next time.
          }
        }

        // Get live measurement for this year
        measurements[currentYear] = await this.api.getSiteMeasurements({
          siteId: this.getData().siteId,
          startDate: `${currentYear}-01-01`,
          endDate: `${currentYear}-12-31`,
        }).then(result => ({
          imported: result.summary.import,
          exported: result.summary.export,
        }));

        let totalImported = 0;
        let totalExported = 0;
        for (const year in measurements) {
          if (measurements[year] === 'missing') {
            continue;
          }

          if (measurements[year] === 'error') {
            throw new Error(`Missing Data For Year ${year}`);
          }

          totalImported += measurements[year].imported;
          totalExported += measurements[year].exported;
        }

        await this.setCapabilityValue('meter_power.imported', Math.round(totalImported / 1000)).catch(this.error);
        await this.setCapabilityValue('meter_power.exported', Math.round(totalExported / 1000)).catch(this.error);
      });

      this.getTotalPromise
        .catch(err => {
          this.error(`Error Fetching Totals: ${err.message}`);
        })
        .finally(() => {
          delete this.getTotalPromise;
        });
    }
  }

};