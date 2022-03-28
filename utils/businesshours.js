const elementService = require('../service/element.service.js').ElementService;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const bunyan = NodePackage.bunyan;
const moment = NodePackage.moment;
const EventEmitter = NodePackage.EventEmitter;
EventEmitter.prototype._maxListeners = 0;
let emitter = new EventEmitter.EventEmitter();
module.exports.businessHours = BusinessHours;
module.exports.emitter = emitter;
function BusinessHours(config, utility) {
    let defaults = config.defaults;
    const elements = config.elements;
    let retryServer = defaults.retry || 10;
    const MILLISINHOUR = 60 * 60 * 1000;
    const MILLISINADAY = 60 * 60 * 24 * 1000;
    const log = bunyan.createLogger({ name: `businesshours`, level: config.logger.loglevel || 20 });
    return {
        name: `businesshours`,
        onStartup: false,
        /**
         * Get All records of businesshours from businesshours element
         */
        async getAllBusinessHours() {
            clearTimeout(this.shiftTimer);
            try {
                let elementName = elements.businesshours || 'businesshours';
                const response = await elementService.getElementRecords(elementName);
                const { status, data } = response;
                if (status === utility.HTTP_STATUS_CODE.SUCCESS && data && data.results) {
                    const allShift = data.results;
                    this.allShift = allShift;
                    if (!this.onStartup) {
                        this.onStartup = true;
                        emitter.emit('init');
                    }
                } else {
                    log.error(`Error in getting BusinessHours ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(data);
                    // wait for execute next function call
                    await utility.setTimer(retryServer);
                    await this.getAllBusinessHours();
                }
            } catch (ex) {
                log.fatal(`Exception in getting all shift ${ex}`);
                // wait for execute next function call
                await utility.setTimer(retryServer);
                await this.getAllBusinessHours();
            }
        },
        /**
         * This method calculate current shift record information
         * @param {Number} timestamp
         */
        getCurrentShiftRecord(timestamp) {
            let currentShift = {};
            for (var i = 0; i < this.allShift.length; i++) {
                const shiftStartSplit = this.allShift[i].starttime.split(':');
                const hour = shiftStartSplit[0];
                const min = shiftStartSplit[1];
                let shiftStartTime = moment(timestamp).format('DD-MM-YYYY');
                shiftStartTime = `${shiftStartTime}:${hour}:${min}`;
                shiftStartTime = moment(shiftStartTime, "DD-MM-YYYY:HH:mm").valueOf();
                let res = this.getShiftForTimestamp(0, timestamp, i, shiftStartTime);
                currentShift = res || {};
                if (res) {
                    break;
                }
            }
            return currentShift;
        },
        /**
        *
        * @param {Int} offset for checking cross day shift
        * @param {*} timestamp
        * @param {*} index shift index
        * @param {*} shiftStartTime startTimestamp of shift
        */
        getShiftForTimestamp(offset, timestamp, index, shiftStartTime) {
            let shiftEndTime = shiftStartTime + this.allShift[index].duration;
            shiftStartTime -= offset * MILLISINADAY;
            shiftEndTime -= offset * MILLISINADAY;
            if (timestamp >= shiftStartTime && timestamp < shiftEndTime) {
                let obj = utility.cloneDeep(this.allShift[index]);
                obj.starttimestamp = shiftStartTime;
                obj.endtimestamp = shiftEndTime;
                const shiftStartobj = this.getShiftDate(obj, timestamp);
                obj.shiftdate = shiftStartobj.shiftdate;
                obj.firstshiftstart = shiftStartobj.firstshiftstart;
                obj.endofshift = shiftStartobj.endofshift;
                const businessHourObj = this.getBusinessHourForTimestamp(timestamp)
                obj.businessHour = businessHourObj.businessHour;
                return obj;
            }
            if (offset === 1) {
                return null;
            }
            return this.getShiftForTimestamp(1, timestamp, index, shiftStartTime)
        },
        /**
         * Method calculate the shift date for downtime split
         * @param {Object} obj Current Shift record
         * @param {Long} timestamp
         */
        getShiftDate(obj, timestamp) {
            const firstShift = this.allShift[0];
            let firstShiftStart = moment(timestamp).format('DD-MM-YYYY') + ':' + firstShift.starttime;
            firstShiftStart = moment(firstShiftStart, "DD-MM-YYYY:HH:mm").valueOf();
            const dayLast = firstShiftStart + MILLISINADAY;
            let shiftStartobj = {};
            if (obj.starttimestamp >= firstShiftStart && obj.starttimestamp < dayLast) {
                shiftStartobj.firstshiftstart = firstShiftStart;
                shiftStartobj.endofshift = dayLast;
                shiftStartobj.shiftdate = moment(firstShiftStart).format('DD-MM-YYYY');
            } else if (obj.starttimestamp >= (firstShiftStart - MILLISINADAY) && obj.starttimestamp < (dayLast - MILLISINADAY)) {
                shiftStartobj.firstshiftstart = firstShiftStart;
                shiftStartobj.endofshift = dayLast;
                shiftStartobj.shiftdate = moment(firstShiftStart - MILLISINADAY).format('DD-MM-YYYY');
            }
            return shiftStartobj;
        },
        /**
         * This method calculate business hour from timestamp
         * @param {Number} timestamp
         */
        getBusinessHourForTimestamp(timestamp) {
            const businessDayStarttime = this.allShift[0].starttime.split(':');// 11,05
            const businessDayStartHour = businessDayStarttime[0];
            const businessDayStartMin = businessDayStarttime[1];
            const currentTime = moment(timestamp).format('HH:mm');// 11,05
            const currentHourMin = currentTime.split(':');
            const currentHour = currentHourMin[0];
            const currentMin = currentHourMin[1];
            let businessHour = currentHour - businessDayStartHour;
            if (businessHour < 0) {
                businessHour = 24 + businessHour;
            }

            let businessHourStarttime = moment(timestamp);
            let businessHourEndtime = moment(timestamp);
            let startHour = currentHour;
            if (currentMin < businessDayStartMin) {
                startHour--;
                businessHour--;
                businessHourStarttime.set({ hour: currentHour, minute: 0, second: 0, millisecond: 0 });
                businessHourStarttime = new Date(businessHourStarttime).getTime();
                businessHourEndtime.set({ hour: currentHour, minute: businessDayStartMin, second: 0, millisecond: 0 });
                businessHourEndtime = new Date(businessHourEndtime).getTime();
            } else {
                businessHourStarttime.set({ hour: startHour, minute: businessDayStartMin, second: 0, millisecond: 0 });
                businessHourStarttime = new Date(businessHourStarttime).getTime();
                businessHourEndtime.set({ hour: Number(startHour) + 1, minute: 0, second: 0, millisecond: 0 });
                businessHourEndtime = new Date(businessHourEndtime).getTime();
            }


            return {
                businessHour: businessHour,
                businessHourStarttime: businessHourStarttime,
                businessHourEndtime: businessHourEndtime,
                businessHourStarttimeStr: new Date(businessHourStarttime),
                businessHourEndtimeStr: new Date(businessHourEndtime),
            };
        }
    }
}