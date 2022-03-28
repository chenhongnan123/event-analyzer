const elementService = require('../service/element.service.js').ElementService;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const bunyan = NodePackage.bunyan;
const moment = NodePackage.moment;
const EventEmitter = NodePackage.EventEmitter;
EventEmitter.prototype._maxListeners = 0;
let emitter = new EventEmitter.EventEmitter();
module.exports.businessHolidays = businessholidays;
module.exports.emitter = emitter;
function businessholidays(config, utility, businessHours){
    let defaults = config.defaults;
    const elements = config.elements;
    let retryServer = defaults.retry || 10;   
    const MILLISINADAY = 60 * 60 * 24 * 1000;
    const log = bunyan.createLogger({ name: `businessholidays`, level: config.logger.loglevel || 20});
    return {
        name : `businessholidays`,
        onStartup : false,
        /**
         * Get All records of shift from shiftmaster table
         */
        async getAllBusinessHolidays(){
            clearTimeout(this.shiftTimer);            
            try {
                let elementName = elements.businessholidays || 'businessholidays'; 
                const response = await elementService.getElementRecords(elementName);
                const {status, data} = response;                
                if(status === utility.HTTP_STATUS_CODE.SUCCESS && data && data.results){
                    const businessHolidays = data.results;
                    this.businessHolidays = businessHolidays;
                    this.checkHoliday();
                    if(!this.onStartup){
                        this.onStartup = true;
                        emitter.emit('init');
                    } 
                } else {
                    log.error(`Error in getting BusinessHolidays ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(data);
                    // wait for execute next function call
                    await utility.setTimer(retryServer);
                    await this.getAllBusinessHolidays();
                }
            } catch(ex) {
                log.fatal(`Exception in getting all BusinessHolidays ${ex}`);
                // wait for execute next function call
                await utility.setTimer(retryServer); 
                await this.getAllBusinessHolidays();
            }
        },
        checkHoliday(timestamp){
            timestamp = timestamp || new Date().valueOf();
            if(this.businessHolidays){
                for(let holiday in this.businessHolidays){
                    let starttime = new Date(this.businessHolidays[holiday].date).valueOf();
                    starttime = moment(starttime).format('DD-MM-YYYY');
                    starttime = moment(starttime + ':' + businessHours.allShift[0].starttime, 'DD-MM-YYYY:HH:mm').valueOf();
                    const endtime = starttime + MILLISINADAY;
                    if(timestamp >= starttime && timestamp < endtime){
                        return this.businessHolidays[holiday];
                    }
                }
            } else {
                return false
            }
        }
    }
}