const shiftService = require('../service/shift.service.js').ShiftService;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const bunyan = NodePackage.bunyan;
const qs = NodePackage.qs;
const moment = NodePackage.moment;
const _ = NodePackage.lodash;
const EventEmitter = NodePackage.EventEmitter;
EventEmitter.prototype._maxListeners = 0;
let emitter = new EventEmitter.EventEmitter();
module.exports.Shift = Shift;
module.exports.emitter = emitter;
function Shift(config, utility){
    let defaults = config.defaults;
    let retryServer = defaults.retry || 10;   
    const MILLISINADAY = 60 * 60 * 24 * 1000;
    const serverDateFormat = 'DD-MM-YYYY:HH:mm:ss';
    const log = bunyan.createLogger({ name: `currentshift`, level: config.logger.loglevel || 20});
    return {
        name : `currentShift`,
        onStartup : false,
        /**
         * Get All records of shift from shiftmaster table
         */
        async getAllShifts(){
            clearTimeout(this.shiftTimer);            
            try {
                const response = await shiftService.getAllShifts();
                const {status, data} = response;                
                if(status == utility.HTTP_STATUS_CODE.SUCCESS && data && data.results){
                    const allShift = data.results;
                    this.allShift = allShift;
                    if(!this.onStartup){
                        this.onStartup = true;
                        emitter.emit('init');
                    } 
                } else {
                    utility.checkSessionExpired(data);
                    // wait for execute next function call
                    await utility.setTimer(retryServer);
                    await this.getAllShifts();
                }
            } catch(ex) {
                log.fatal(`Exception in getting all shift ${ex}`);
                // wait for execute next function call
                await utility.setTimer(retryServer);
                await this.getAllShifts();
            }
        },

        getCurrentShiftRecord(timestamp){
            let currentShift = {};
            for(var i = 0; i < this.allShift.length; i++){
                const shiftStartSplit = this.allShift[i].starttime.split(':');
                const hour = shiftStartSplit[0];
                const min = shiftStartSplit[1];
                const sec = shiftStartSplit[2];
                let shiftStartTime = moment(timestamp).format('DD-MM-YYYY');
                shiftStartTime = `${shiftStartTime}:${hour}:${min}:${sec}`;
                shiftStartTime = moment(shiftStartTime, 'DD-MM-YYYY:HH:mm:ss').valueOf();
                let res = this.getShiftForTimestamp(0, timestamp, i, shiftStartTime);
                currentShift = res || {};
                if(res){                 
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
        getShiftForTimestamp(offset, timestamp, index, shiftStartTime){
            let shiftEndTime = shiftStartTime + this.allShift[index].durationinmilliseconds;
            shiftStartTime -= offset * MILLISINADAY;
            shiftEndTime -= offset *  MILLISINADAY;
            if(timestamp >= shiftStartTime && timestamp < shiftEndTime){
                let obj = _.cloneDeep(this.allShift[index]);
                obj.starttimestamp = shiftStartTime;
                obj.endtimestamp = shiftEndTime;
                let shiftStartobj = this.getShiftDate(obj, timestamp);
                obj.shiftdate = shiftStartobj.shiftdate;
                obj.firstshiftstart = shiftStartobj.firstshiftstart;
                obj.endofshift = shiftStartobj.endofshift;
                return obj;
            }
            if(offset == 1){
                return null;
            }
            return this.getShiftForTimestamp(1, timestamp, index, shiftStartTime)
        },
        /**
         * Method calculate the shift date for downtime split
         * @param {Object} obj Current Shift record
         * @param {Long} timestamp 
         */
        getShiftDate(obj, timestamp){
            const firstShift = this.allShift[0];
            let firstShiftStart = moment(timestamp).format('DD-MM-YYYY') + ':' + firstShift.starttime;
            firstShiftStart = moment(firstShiftStart, serverDateFormat).valueOf();
            const dayLast = firstShiftStart + MILLISINADAY;
            let shiftStartobj= {};
            if(obj.starttimestamp >= firstShiftStart && obj.starttimestamp < dayLast){
                shiftStartobj.firstshiftstart = firstShiftStart;
                shiftStartobj.endofshift = dayLast;
                shiftStartobj.shiftdate = moment(firstShiftStart).format('DD-MM-YYYY');
            } else if(obj.starttimestamp >= (firstShiftStart-MILLISINADAY) && obj.starttimestamp < (dayLast - MILLISINADAY)){
                shiftStartobj.firstshiftstart = firstShiftStart;
                shiftStartobj.endofshift = dayLast;
                shiftStartobj.shiftdate = moment(firstShiftStart-MILLISINADAY).format('DD-MM-YYYY');
            }
            return shiftStartobj;
        }
    }
}