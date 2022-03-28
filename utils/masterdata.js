'use strict';
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const elementService = require('../service/element.service.js').ElementService;
const bunyan =  NodePackage.bunyan;
function masterdata(config, utility, tags, MESSAGESCODE) {
    const log = bunyan.createLogger({ name: 'Master Data', level: config.logger.loglevel})
    const elements = config.elements;
    const defaults = config.defaults;
    const parameterTags = tags.parametertags;
    const sublineTags = tags.sublinetags;
    const substationTags = tags.substationtags;
    let retryServerTimer = defaults.retryServerTimer || 10;   // in seconds

    return {
        stationInfo: [],
        /**
         * This method all the recipes from recipedetails element
         */
        async getStationInformation() {
            const elementName = elements.substation || 'substation';
            try {
                /*
                    query = `query=lineid==1%26%26sublineid=="subline-1"%26%26sublineid=="sublineid-1"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
                */
                // Bug RA-I378 
                let query = `query=${[substationTags.SUBLINEID_TAG]}=="${config.sublineid}"`;
                query += `&sortquery=createdTimestamp==-1`;
                const response = await elementService.getElementRecords(elementName, query)
                if(response.data && response.data.results && response.data.results.length) {
                    log.error(`station fetched successfully`);
                    this.stationInfo = response.data.results;
                    await this.getEdgeDeviceIP(this.stationInfo[0]);
                    if(!config.kafkaEdge.host) {
                        log.error(`Edge device IP address not set. Stop Service forcefully!!!`);
                        process.exit();
                    }
                } else {
                    log.error(`station not found for elementName : ${elementName} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    await utility.setTimer(retryServerTimer);
                    await this.getStationInformation();
                }
            } catch (ex) {
                log.error(`Exception to fetch recipe for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex 
                log.error(messageObject);
                await utility.setTimer(retryServerTimer);
                await this.getStationInformation();
            }
        },
        /**
             * This method get the edge device IP address from subline element
             * @param {*} data 
             */
        async getEdgeDeviceIP(data) {
            const elementName = elements.subline || 'subline';
            let sublineid = data[substationTags.SUBLINEID_TAG] ? data[substationTags.SUBLINEID_TAG]: false;
            if(sublineid) {
                try {
                    let query = `query=${[sublineTags.SUBLINEID_TAG]}=="${sublineid}"`;
                    query += `&pagenumber=1&pagesize=1`;
                    log.error(`Query to get subline `, query);
                    const response = await elementService.getElementRecords(elementName, query)
                    if(response.data && response.data.results) {
                        log.error(`Got subline successfully`);
                        if(response.data.results.length > 0) {
                            config.kafkaEdge.host = response.data.results[0][sublineTags.IPADDRESS_TAG];
                        } else {
                            log.error(`subline not found for elementName : ${elementName} ${JSON.stringify(response.data)}`);
                        }
                    } else {
                        log.error(`Error in getting subline record ${JSON.stringify(response.data)}`);
                        utility.checkSessionExpired(response.data);
                        await utility.setTimer(retryServerTimer);
                        await this.getEdgeDeviceIP(data);
                    }
                } catch (ex) {
                    log.error(`Exception to fetch subline for element : ${elementName}`);
                    const messageObject = ex.response ? ex.response.data : ex 
                    log.error(messageObject);
                    await utility.setTimer(retryServerTimer);
                    await this.getEdgeDeviceIP(data);
                }
            } else {
                log.error(`subline not found in parameter record`);
            }
        }
    }
}

module.exports = {
    masterdata
}