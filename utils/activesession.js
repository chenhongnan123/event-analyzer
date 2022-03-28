'use strict';
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const elementService = require('../service/element.service.js').ElementService;
const bunyan =  NodePackage.bunyan;
function activesession(config, utility) {
    const log = bunyan.createLogger({ name: 'ActiveSession', level: config.logger.loglevel})
    let defaults = config.defaults;
    let serverPollingTime = defaults.serverpollingtime || 300;
    let elements = config.elements;
    return {
        /**
         * This method used to avoiding Invalid Session after every 300 seconds
         */
        async updateSessionTime() {
            try {
                // call this method every 300 seconds for avoiding Invalid Session
                setTimeout(()=> {
                    this.updateSessionTime();
                }, serverPollingTime * 1000);

                let elementName = elements.businesshours || 'businesshours';
                const response = await elementService.getElementRecords(elementName, `sortquery=sortindex==1&pagenumber=1&pagesize=1`);
                const {status, data} = response;
                if(status === utility.HTTP_STATUS_CODE.SUCCESS && data && data.results){
                   log.error(`Got hour`);
                } else {
                    log.error(`Error in update session time `);
                    utility.checkSessionExpired(data);                    
                }
           } catch(ex) {
                log.fatal(`Exception in activate session id continuously ${ex}`);
           }
        }
    }
}

module.exports = {
    activesession
}