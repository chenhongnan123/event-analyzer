'use strict'
module.exports.subAssemblyCheck = subAssemblyCheck;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const subassemblyValues = require('../utils/constant').subassemblyresult;

function subAssemblyCheck(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE) {
    const substationTags = tags.substationtags;
    const parameterTags = tags.parametertags;
    const checkoutTags = tags.checkouttags;
    const roadmapTags = tags.roadmaptags;
    const staticTags = tags.statictags;
    const socketio = config.feedbacktoplcsocketio;
    const elements = config.elements;
    const defaults = config.defaults;
    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let stationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    let previousvalidatebit = 0;
    const maxServerRetryCount = defaults.maxServerRetryCount;
    let retryServerTimer = defaults.retryServerTimer; // in seconds
    const feebackWriteCount = defaults.maxPLCRetrySubAssemblyCheckFeedbackCount;
    const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
    const resetValueDealyTime = defaults.resetValueDealyTime || 2;

    let writeSubAssemblyCheckResultFlag = false;
    let SubAssemblyCheckResult;
    let SubAssemblyCheckResultCount = 0;
    let writeSubAssemblyCheckResultTimer;

    let writeSubAssemblyCheckCompletedFlag = false;
    let SubAssemblyCheckCompleted;
    let SubAssemblyCheckCompleteCount = 0;
    let writeSubAssemblyCheckCompleteTimer;

    let resetSubAssemblyCheckCompletedFlag = false;
    let resetSubAssemblyCheckCompletedCount = 0;

    const log = bunyan.createLogger({ name: `SubAssemblyCheck_${substationid}`, level: config.logger.loglevel });
    return {
        /**
         * This method update the substation information when update event triggered
         * @param {Object} stationinfo 
         */
        updateStation(stationinfo) {
            substation = stationinfo;
            lineid = substation[stationTags.LINEID_TAG];
            sublineid = substation[stationTags.SUBLINEID_TAG];
            substationname = substation[stationTags.NAME_TAG];
            substationid = substation[stationTags.SUBSTATIONID_TAG];
        },
        /**
         * This method process SubAssemblyCheckTrigger 
         * @param {Object} data 
         */
        processStationData(data1) {
            let data = utility.cloneDeep(data1);
            let removePrefix = 'q_';
            let removeParameter = 's_';
            data = utility.modifyObject(data, removePrefix, removeParameter);
            // check if feedback is written successfully on PLC or not
            if (data[staticTags.SUBASSEMBLYCHECKTRIGGER_TAG] === 1) {
                this.CheckFeedbacktoPLC(data);
            }
            if (!data[staticTags.SUBASSEMBLYCHECKTRIGGER_TAG]) {
                if (previousvalidatebit) {
                    resetSubAssemblyCheckCompletedFlag = true;
                    resetSubAssemblyCheckCompletedCount = 0;
                }
                this.resetAck(data);
            }
            if (!data[staticTags.SUBASSEMBLYCHECKTRIGGER_TAG]) {
                previousvalidatebit = 0;
            }

            if (previousvalidatebit === 0 && data[staticTags.SUBASSEMBLYCHECKTRIGGER_TAG] === 1) {
                log.error(`Sub Assembly Check  Triggered ${JSON.stringify(data)}`);
                previousvalidatebit = 1;
                SubAssemblyCheckResultCount = 0;
                SubAssemblyCheckCompleteCount = 0;
                resetSubAssemblyCheckCompletedCount = 0;
                this.write = false;
                this.reset = false;
                this.processSubAssemblyCheckTrigger(data);
            }
        },
        processSubAssemblyCheckTrigger(plcdata) {
            const isMainID = this.checkMainId(plcdata);
            if (isMainID) {
                const isRoadMap = this.checkRoadMap();
                if (isRoadMap) {
                    this.checkLastStation(plcdata);
                }
            }
        },
        /**
         * This method check the overall result in partstatus for substation
         * @param {Object} plcdata 
         */
        async checkLastStation(plcdata) {
            const elementName = elements.partstatus || 'partstatus';
            try {
                // no need to add query for stationid we need to check the last substation result
                /*
                    query = `query=lineid==1%26%26mainid=="MainId1"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
                */
                let query = `query=${[checkoutTags.LINEID_TAG]}==${lineid}`;
                query += `%26%26${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.SUBASSEMBLYID_TAG]}"`;
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                log.trace(`Check Part Status in Init Station query : ${query}`)
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        this.checkOverAllResult(plcdata, response.data.results[0]);
                    } else {
                        log.error(`${plcdata[staticTags.MAINID_TAG]} MainId not found in partstatus element`);
                        SubAssemblyCheckResult = subassemblyValues.ERROR;
                        writeSubAssemblyCheckResultFlag = true;
                        plcdata[staticTags['CHECKSUBASSEMBLYIDRESULT_TAG']] = subassemblyValues.ERROR;
                        this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);
                    }

                } else {
                    log.error(`Error in getting mainid for subassembly check`);
                    SubAssemblyCheckResult = subassemblyValues.ERROR;
                    writeSubAssemblyCheckResultFlag = true;
                    plcdata[staticTags['CHECKSUBASSEMBLYIDRESULT_TAG']] = subassemblyValues.ERROR;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);
                }
            } catch (ex) {
                log.error(`Exception in getting mainid for subassembly check ${ex}`);
                SubAssemblyCheckResult = subassemblyValues.ERROR;
                writeSubAssemblyCheckResultFlag = true;
                plcdata[staticTags['CHECKSUBASSEMBLYIDRESULT_TAG']] = subassemblyValues.ERROR;
                this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);
            }
        },
        /**
         * This method check the overall result of subline
         * @param {Object} plcdata 
         * @param {Object} lastStationData 
         */
        checkOverAllResult(plcdata, lastStationData) {
            const status = lastStationData[checkoutTags.OVERALLRESULT_TAG];
            if (status === subassemblyValues.NG) {
                // ng status
                SubAssemblyCheckResult = subassemblyValues.NG;
                writeSubAssemblyCheckResultFlag = true;
                plcdata[staticTags['CHECKSUBASSEMBLYIDRESULT_TAG']] = subassemblyValues.NG;
                this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);

            } else if (status === subassemblyValues.ERROR) {
                // unknown status
                SubAssemblyCheckResult = subassemblyValues.ERROR;
                writeSubAssemblyCheckResultFlag = true;
                plcdata[staticTags['CHECKSUBASSEMBLYIDRESULT_TAG']] = subassemblyValues.ERROR;
                this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);

            } else if (status === subassemblyValues.COMPLETED) {
                // completed status
                SubAssemblyCheckResult = subassemblyValues.COMPLETED;
                writeSubAssemblyCheckResultFlag = true;
                plcdata[staticTags['CHECKSUBASSEMBLYIDRESULT_TAG']] = subassemblyValues.COMPLETED;
                this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);

            } else if (status === subassemblyValues.OK) {
                SubAssemblyCheckResult = subassemblyValues.OK;
                writeSubAssemblyCheckResultFlag = true;
                plcdata[staticTags['CHECKSUBASSEMBLYIDRESULT_TAG']] = subassemblyValues.OK;
                this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);
                this.checkProcessParametersForMainId(plcdata);
            }
        },
        /**
         * This method check the main id in substation id in roadmap for subline connected to the station
         * @param {Object} plcdata 
         */
        async checkProcessParametersForMainId(plcdata) {
            try {
                const elementName = config.sublinesubstation;
                if (elementName) {
                    let query = `query=${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.SUBASSEMBLYID_TAG]}"`;
                    query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                    const response = await elementService.getElementRecords(elementName, query)
                    if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                        if (response.data && response.data.results && response.data.results.length > 0) {
                            this.writeProcessParameter(response.data.results[0])
                        } else {
                            log.error(`No process data found for main id ${plcdata[staticTags.SUBASSEMBLYID_TAG]} in ${elementName}`)
                        }
                    }
                } else {
                    log.error(`Please check the subline substation configured in config or not`);
                }
            } catch (ex) {
                log.error(`Exception in getting process parameters of subline substation in roadmap ${ex}`);
            }
        },
        /**
         * This method write the process parameters to PLC
         * @param {Object} response 
         */
        async writeProcessParameter(response) {
            const processParameters = this.getProcessParameter();
            if (processParameters.length > 0) {
                for (var param in processParameters) {
                    if (response[processParameters[param]] || response[processParameters[param]] === 0) {
                        this.postDatatoSocketPLCWrite(processParameters[param], response[processParameters[param]])
                    }
                }
            } else {
                log.error(`Process parameters not configured for this station`);
            }
        },
        /**
         * This method get the process parameters from parameters based on parameter category i.e. 15, 17, 18
         */
        getProcessParameter() {
            const processparameters = [];
            PARAMETERS.parametersList.filter((item) => {
                if (item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.processparameters || item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.subprocessparameters || item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.subprocessresult) {
                    processparameters.push(item[parameterTags.PARAMETERNAME_TAG]);
                }
            })
            return processparameters;
        },
        /**
         * This method check the mainid is presnt in plc data or not
         * @param {Object} plcdata 
         */
        checkMainId(plcdata) {
            if (plcdata[staticTags.MAINID_TAG]) {
                // MAINID/CARRIERID Present in PLC data
                return true;
            } else {
                log.error(`MainID missing in PLC data`);
                // TODO write result to PLC or not
                return false;
            }
        },
        /**
         * This method check the Roadmap is present or not for the substation
         * @param {Object} plcdata 
         */
        checkRoadMap() {
            const runningRoadMap = ORDER.runningOrder[0].runningRoadMap;
            if (!substation[substationTags.INITIALSUBSTATION_TAG] && runningRoadMap.length === 0) {
                return false;
            }
            return true;
        },
        /**
         * This method check recipe written on PLC. If not then retry for configurable number of count
         * @param {Object} data 
         */
        CheckFeedbacktoPLC(data) {
            // check SubAssemblyCheckResult
            if (writeSubAssemblyCheckResultFlag) {
                // if SubAssemblyCheckResult value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = SubAssemblyCheckResult === data[staticTags.CHECKSUBASSEMBLYIDRESULT_TAG] ? true : false;
                if (!isValid && SubAssemblyCheckResultCount < feebackWriteCount) {
                    log.error(`Retry write SubAssemblyCheckResult to PLC after count ${SubAssemblyCheckResultCount}`);
                    clearTimeout(writeSubAssemblyCheckResultTimer);
                    writeSubAssemblyCheckResultFlag = false;
                    // plc polling is reduced to 50 ms
                    writeSubAssemblyCheckResultTimer = setTimeout(() => {
                        writeSubAssemblyCheckResultFlag = true;
                    }, retryToPLCTimer);
                    SubAssemblyCheckResultCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);

                } else if (!isValid && SubAssemblyCheckResultCount === feebackWriteCount) {
                    log.error(`Error in write SubAssemblyCheckResult to PLC after count ${SubAssemblyCheckResultCount}`);
                    // after 3 times retry error in writing to PLC
                    writeSubAssemblyCheckResultFlag = false;
                    // no need to write completed because default value is 0
                    // SubAssemblyCheckCompleted = 0;
                    // writeSubAssemblyCheckCompletedFlag = true;
                } else if (isValid) {
                    // if all ok then stop validation
                    writeSubAssemblyCheckResultFlag = false;
                    SubAssemblyCheckCompleted = 1;
                    writeSubAssemblyCheckCompletedFlag = true;

                }
            }
            // SubAssemblyCheckCompleted
            if (writeSubAssemblyCheckCompletedFlag) {
                const isValid = SubAssemblyCheckCompleted === data[staticTags.CHECKSUBASSEMBLYIDCOMPLETED_TAG] ? true : false;
                if (!isValid && SubAssemblyCheckCompleteCount < feebackWriteCount) {
                    log.error(`Retry write value of SubAssemblyCheckCompleted to PLC after count ${SubAssemblyCheckCompleteCount}`);
                    clearTimeout(writeSubAssemblyCheckCompleteTimer);
                    writeSubAssemblyCheckCompletedFlag = false;
                    // plc polling is reduced to 50 ms
                    writeSubAssemblyCheckCompleteTimer = setTimeout(() => {
                        writeSubAssemblyCheckCompletedFlag = true;
                    }, retryToPLCTimer);

                    SubAssemblyCheckCompleteCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDCOMPLETED_TAG, SubAssemblyCheckCompleted);

                } else if (!isValid && SubAssemblyCheckCompleteCount === feebackWriteCount) {
                    log.error(`Error in write value of SubAssemblyCheckCompleted to PLC after count ${SubAssemblyCheckCompleteCount}`);
                    // after 3 times retry error in write SubAssemblyCheckCompleted on PLC
                    writeSubAssemblyCheckCompletedFlag = false;

                } else if (isValid) {
                    // SubAssemblyCheckCompleted written successfully on PLC
                    log.error('SubAssemblyCheckCompleted', SubAssemblyCheckCompleted, 'writeSubAssemblyCheckCompletedFlag: ', writeSubAssemblyCheckCompletedFlag);
                    writeSubAssemblyCheckCompletedFlag = false;
                }
            }
        },
        /**
         * Reset the values i.e. who write who reset
         * @param {Object} data 
         */
        resetAck(data) {
            // reset SubAssemblyCheckResult, SubAssemblyCheckCompleted
            const isSubAssemblyCheckCompleted = 0 === data[staticTags.CHECKSUBASSEMBLYIDCOMPLETED_TAG] ? true : false;
            if (!this.reset && resetSubAssemblyCheckCompletedFlag) {
                this.reset = true;
                setTimeout(() => {
                    this.write = true;
                }, resetValueDealyTime * 1000);
            } else if (this.write && resetSubAssemblyCheckCompletedFlag) {
                // reset SubAssemblyCheckCompleted 
                if (resetSubAssemblyCheckCompletedFlag && !isSubAssemblyCheckCompleted && resetSubAssemblyCheckCompletedCount < feebackWriteCount) {
                    log.error(`Retry write reset value of SubAssemblyCheckCompletedFlag to PLC`);
                    clearTimeout(this.resetSubAssemblyCheckCompleteTimer);
                    resetSubAssemblyCheckCompletedFlag = false;
                    // plc polling is reduced to 50 ms
                    this.resetSubAssemblyCheckCompleteTimer = setTimeout(() => {
                        resetSubAssemblyCheckCompletedFlag = true;
                    }, retryToPLCTimer);

                    resetSubAssemblyCheckCompletedCount++;
                    SubAssemblyCheckResult = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDRESULT_TAG, SubAssemblyCheckResult);
                    SubAssemblyCheckCompleted = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKSUBASSEMBLYIDCOMPLETED_TAG, SubAssemblyCheckCompleted);

                } else if (!isSubAssemblyCheckCompleted && resetSubAssemblyCheckCompletedCount === feebackWriteCount) {
                    log.error(`Error in write reset value of SubAssemblyCheckCompleted to PLC after count ${resetSubAssemblyCheckCompletedCount}`);
                    resetSubAssemblyCheckCompletedCount++;
                    // after 3 times retry error in write reset values on PLC
                    resetSubAssemblyCheckCompletedFlag = false;

                } else if (isSubAssemblyCheckCompleted) {
                    // reset values written successfully on PLC
                    resetSubAssemblyCheckCompletedFlag = false;
                }
            }
        },
        /**
        * This method send the data to Pre-Analyzer for writing into PLC
        * @param {Object} payload 
        */
        async postDatatoSocketPLCWrite(parametername, value) {
            let payload = {};
            payload[parameterTags.SUBSTATIONID_TAG] = substationid;
            payload[parameterTags.PARAMETERNAME_TAG] = parametername;
            payload.value = value;
            log.error(`PLC Write Payload ${JSON.stringify(payload)}`);
            let url = `${socketio.protocol}://${socketio.host}:${socketio.port}/${socketio.namespace}/${socketio.eventname}_plcwrite`;
            try {
                let response = await socketService.post(url, payload);
                log.trace(`Payload for Pre-Analyzer ${JSON.stringify(payload)}`);
                if (response && response.status == utility.HTTP_STATUS_CODE.SUCCESS && response.data) {
                    log.trace(`Data send successfully on socket for ${substationid} - ${JSON.stringify(response.data)}`);
                } else {
                    log.error(`Error in sending data to socket for PLC Live bit status code ${response.status} ${JSON.stringify(response.data)}`);
                }

            } catch (ex) {
                log.error(`Exception in writing data to socket ${ex}`);
            }
        }
    }
}