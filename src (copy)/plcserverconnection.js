'use strict';
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const bunyan = NodePackage.bunyan;
const socketService = require('../service/socket.service').SocketService;
module.exports.PLCServerConnection = PLCServerConnection;
function PLCServerConnection(config, station, utility, tags, MESSAGESCODE) {
    const substationTags = tags.substationtags;
    const staticTags = tags.statictags;
    const parameterTags = tags.parametertags;
    const socketio = config.serverlivetoplcsocketio;
    let lineid = station[substationTags.LINEID_TAG];
    let sublineid = station[substationTags.SUBLINEID_TAG];
    let stationname = station[substationTags.NAME_TAG];
    let substationid = station[substationTags.SUBSTATIONID_TAG];
    let serverLiveFlag = true, serverLiveTimeout, plcLiveTimeout;
    // serverLivePollingInterval used to reset the server live signal and plcLivePollingInterval is used to check plc live signal updated or not
    const serverLivePollingInterval = 1, plcLivePollingInterval = 2;
    let previousPLCLiveStatus;
    const log = bunyan.createLogger({ name: `PLCServerConnection_${substationid}`, level: config.logger.loglevel });

    return {
        /**
         * Update Station Infomration
         */
        updateStationInfomraton(stationInfo) {
            lineid = stationInfo[substationTags.LINEID_TAG];
            sublineid = stationInfo[substationTags.SUBLINEID_TAG];
            stationname = stationInfo[substationTags.NAME_TAG];
            substationid = stationInfo[substationTags.SUBSTATIONID_TAG];
        },
        /**
         * This method check the Server and PLC live or not
         * @param {*} data It contains PLC data
         */
        checkPLCServerConnection(data) {
            this.serverLive(data);

            this.plcLive(data);
        },
        /**
         * This method write the 1 / 0 to PLC every 1 seconds
         * @param {Object} data 
         */
        serverLive(data) {

            if (serverLiveFlag && (data[staticTags.SERVERLIVE_TAG] || data[staticTags.SERVERLIVE_TAG] == 0)) {

                serverLiveFlag = false;
                //clear timeout
                clearTimeout(serverLiveTimeout);
                // plc polling is reduced to 50 ms
                serverLiveTimeout = setTimeout(() => {
                    serverLiveFlag = true;
                }, serverLivePollingInterval * 1000);
                const value = data[staticTags.SERVERLIVE_TAG] ? 0 : 1;
                let payload = {};
                payload[parameterTags.SUBSTATIONID_TAG] = substationid;
                payload[parameterTags.PARAMETERNAME_TAG] = staticTags.SERVERLIVE_TAG;
                payload.value = value;
                // send serverlivebit 1 / 0 to Pre-Analyzer
                this.postDatatoSocketPLCWrite(payload);
                payload[parameterTags.PARAMETERNAME_TAG] = staticTags.SERVERONLINE_TAG;
                payload.value = 1;
                // send serveronline 1 to Pre-Analyzer
                this.postDatatoSocketPLCWrite(payload);
            }
        },
        /**
         * This method check the PLC is live or not based on PLCLive signal
         * @param {Object} data 
         */
        plcLive(data) {

            const value = data[staticTags.PLCLIVE_TAG] ? 0 : 1;

            if (value != previousPLCLiveStatus) {

                previousPLCLiveStatus = value;
                clearTimeout(plcLiveTimeout);
                // If PLC Live Flag does not change to 1 / 0 after 2 seconds then log 
                // PLC live error
                plcLiveTimeout = setTimeout(() => {
                    this.plcLiveError();
                    previousPLCLiveStatus = null;
                }, plcLivePollingInterval * 1000);

            }

        },
        plcLiveError() {
            // log.error(`PLC Live connection error bit does not updated after every 1 seconds`);
        },
        /**
        * 
        * @param {Object} payload 
        */
        async postDatatoSocketPLCWrite(payload) {
            payload = utility.cloneDeep(payload);
            let url = `${socketio.protocol}://${socketio.host}:${socketio.port}/${socketio.namespace}/${socketio.eventname}_plcwrite`;
            try {
                log.trace(`Payload ${JSON.stringify(payload)}`);
                let response = await socketService.post(url, payload);
                log.trace(`Paylaod for Pre-Analyzer Server Live / Server Online ${JSON.stringify(payload)}`);
                if (response && response.status == utility.HTTP_STATUS_CODE.SUCCESS && response.data) {
                    // log.trace(`Data send successfully on socket for ${lineid} ${sublineid} ${substationid} - ${JSON.stringify(response.data)}`);
                } else {
                    log.error(`Error in sending data to socket for PLC Live bit status code ${response.status} ${JSON.stringify(response.data)}`);
                }
            } catch (ex) {
                log.error(`Exception in writing data to socket ${ex}`);
            }
        }
    }
}
