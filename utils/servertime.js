'use strict';
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const servertimeService = require('../service/servertime.service.js').ServertimeService;
const bunyan =  NodePackage.bunyan;
function servertime(config, utility) {
    const log = bunyan.createLogger({ name: 'ServerTime', level: config.logger.loglevel})
    let retryServerTimer = 10;
    return {
        /**
         * This method all the recipes from recipedetails element
         */
        async getServerTime() {
            try {
                const response = await servertimeService.getServerTime()
                if(response.data && response.data.results) {
                    // server time received
                } else {
                    utility.checkSessionExpired(response.data);
                }
            } catch (ex) {
                log.error(`Exception to fetch servertime ${ex}`);
            }
            await utility.setTimer(retryServerTimer);
            this.getServerTime();
        }
    }
}

module.exports = {
    servertime
}