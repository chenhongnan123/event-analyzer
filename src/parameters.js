'use strict';
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const elementService = require('../service/element.service.js').ElementService;
const bunyan =  NodePackage.bunyan;
function parameters(config, substation, utility, tags, MESSAGESCODE, emitter) {
    const log = bunyan.createLogger({ name: 'Parameters', level: config.logger.loglevel})
    const elements = config.elements;
    const defaults = config.defaults;
    const parameterTags = tags.parametertags;
    const substationTags = tags.substationtags;
    let retryServerTimer = defaults.retryServerTimer || 10;   // in seconds
    let lastSocketEventTime = new Date().valueOf();
    return {
        parametersList: [],
        /**
         * Intialize the socket listener on startup of E.A.
         */
        initEmitter() {
            /**
             * Recipe Upload Event recived from Recipe Management App 
             */
            emitter.on('parameters', async (data) => {
                const diff = new Date().valueOf() - lastSocketEventTime;
                // avoid multiple socket event recived within 5 seconds then call getAllParameters method
                if(diff > 5 * 1000) {
                    log.error(`Socket Event received for parameters`);
                    lastSocketEventTime = new Date().valueOf();
                    await utility.setTimer(5);
                    this.getParameters();
                }
            })
        },
        async getParameters() {
            const elementName = elements.parameters || 'parameters';
            try {
                log.error(`Get Parameters`);
                const lineid = substation[substationTags.LINEID_TAG];
                const sublineid = substation[substationTags.SUBLINEID_TAG];
                const substationid = substation[substationTags.SUBSTATIONID_TAG];
                let query = `query=${[parameterTags.LINEID_TAG]}==${lineid}%26%26${[parameterTags.SUBLINEID_TAG]}=="${sublineid}"%26%26${[parameterTags.SUBSTATIONID_TAG]}=="${substationid}"`;
                const response = await elementService.getElementRecords(elementName, query)
                if(response.data && response.data.results) {
                    this.parametersList = response.data.results;
                } else {
                    log.error(`parameter not found for elementName : ${elementName} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    await this.getParameters();
                }
            } catch (ex) {
                log.error(`Exception to fetch parameter for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex 
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                await this.getParameters();
            }
        }
    }
}

module.exports = {
    parameters
}