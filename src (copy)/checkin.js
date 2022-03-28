'use strict'
module.exports.checkin = checkin;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const CheckInResultValues = require('../utils/constant').checkinresult;
function checkin(config, substation, PARAMETERS, ORDER, VIRTUALMAINID, utility, tags, MESSAGESCODE, emitter) {
    const substationTags = tags.substationtags;
    const orderdetailsTags = tags.orderdetailstags;
    const parameterTags = tags.parametertags;
    const recipedetailsTags = tags.recipedetailstags;
    const checkoutTags = tags.checkouttags;
    const checkinTags = tags.checkintags;
    const roadmapTags = tags.roadmaptags;
    const staticTags = tags.statictags;
    const socketio = config.feedbacktoplcsocketio;
    const elements = config.elements;
    const defaults = config.defaults;
    const mainidConfig = JSON.parse(substation.jsondata).mainid || {};
    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let substationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    let previousvalidatebit = 0;
    const maxServerRetryCount = defaults.maxServerRetryCount;
    let retryServerTimer = defaults.retryServerTimer; // in seconds
    const feebackWriteCount = defaults.maxPLCRetryCheckinFeedbackCount;
    const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
    const resetValueDealyTime = defaults.resetValueDealyTime || 2;
    let writeCheckInResultFlag = false;
    let CheckInResult;
    let writeCheckInResultTimer;
    let writeCheckInNGCodeFlag = false;
    let CheckInNGCode;
    let writeCheckInNGCodeTimer;
    let writeCheckInProcessCodeFlag = false;
    let CheckInProcessCode;
    let writeCheckInProcessCodeTimer;

    let writeCheckInCompletedFlag = false;
    let CheckInCompleted;
    let CheckInCompleteCount = 0;
    let writeCheckInCompleteTimer;

    let CheckInResultCount = 0;
    let CheckInNGCodeCount = 0;
    let CheckInProcessCodeCount = 0;

    let resetCheckInCompletedFlag = false;

    let resetCheckInCompletedCount = 0;
    let checkinSchema = [];
    const log = bunyan.createLogger({ name: `Checkin_${substationid}`, level: config.logger.loglevel });
    return {
        processdata: [],
        async getCheckinSchema() {
            const elementName = elements.checkin;
            try {
                const response = await elementService.getElement(elementName)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results) {
                        checkinSchema = response.data.results.tags;
                    } else {
                        log.error(`Error in getting schema for element : ${elementName}`)
                        utility.checkSessionExpired(response.data);
                        await utility.setTimer(retryServerTimer);
                        await this.getCheckinSchema();
                    }
                }
            } catch (ex) {
                log.error(`Exception in getting schema for element : ${elementName} ${ex}`);
                await utility.setTimer(retryServerTimer);
                await this.getCheckinSchema();
            }
        },
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
         * This method process checkintrigger
         * @param {Object} data
         */
        processStationData(data1) {
            let data = utility.cloneDeep(data1);
            let removePrefix = 'q_';
            let removeParameter = 's_';
            data = utility.modifyObject(data, removePrefix, removeParameter);
            // check if feedback is written successfully on PLC or not
            if (data[staticTags.CHECKINTRIGGER_TAG] === 1) {
                this.CheckInFeedbacktoPLC(data);
            }
            if (!data[staticTags.CHECKINTRIGGER_TAG]) {
                if (previousvalidatebit) {
                    resetCheckInCompletedFlag = true;
                    resetCheckInCompletedCount = 0;
                }
                this.resetAck(data);
            }
            if (!data[staticTags.CHECKINTRIGGER_TAG]) {
                this.restAllFlag();
                previousvalidatebit = 0;
            }

            if (previousvalidatebit === 0 && data[staticTags.CHECKINTRIGGER_TAG] === 1) {
                log.error(`Checkin Triggered ${JSON.stringify(data)}`);
                previousvalidatebit = 1;
                CheckInResultCount = 0;
                CheckInCompleteCount = 0;
                CheckInNGCodeCount = 0;
                CheckInProcessCodeCount = 0;
                this.targetSubStationCount = 0;
                this.mainIdCount = 0;
                this.processdataCount = 0;
                resetCheckInCompletedFlag = false;
                this.write = false;
                this.reset = false;
                if (substation[substationTags.INITIALSUBSTATION_TAG]) {
                    this.CommonCheckInInit(data);
                } else {
                    // normal/final substations
                    this.CommonCheckInNormalOrFinal(data);
                }
            }
        },
        /**
         * This method check recipe written on PLC. If not then retry for configurable number of count
         * @param {Object} data
         */
        CheckInFeedbacktoPLC(data) {
            let plcdata = data;
            // check CheckInResult
            if (writeCheckInResultFlag) {
                // if CheckInResult value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = CheckInResult === data[staticTags.CHECKINRESULT_TAG] ? true : false;
                if (!isValid && CheckInResultCount < feebackWriteCount) {
                    clearTimeout(writeCheckInResultTimer);
                    this.resetCheckInResultFlag()
                    // plc polling is reduced to 50 ms
                    writeCheckInResultTimer = setTimeout(() => {
                        this.setCheckInResultFlag()
                    }, retryToPLCTimer);
                    CheckInResultCount++;
                    log.error(`Write Feedback to PLC as ${CheckInResult}`);
                    this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);

                } else if (!isValid && CheckInResultCount === feebackWriteCount) {
                    // after 3 times retry error in writing to PLC
                    log.error(`${MESSAGESCODE.XXX05023}`);
                    this.writeMessageToKafka(plcdata, "XXX05023")
                    this.resetCheckInResultFlag()

                } else if (isValid) {
                    // if all ok then stop validation
                    this.resetCheckInResultFlag()
                    CheckInCompleted = 1;
                    writeCheckInCompletedFlag = true;

                }
            }
            // check targetSubStation
            if (this.writeTargetSubStatationFlag) {
                // if targetSubStation value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = this.targetSubStation === data[staticTags.TARGETSUBSTATION_TAG] ? true : false;
                if (!isValid && this.targetSubStationCount < feebackWriteCount) {
                    clearTimeout(this.targetSubStationTimer);
                    this.writeTargetSubStatationFlag = false;
                    // plc polling is reduced to 50 ms
                    this.targetSubStationTimer = setTimeout(() => {
                        this.writeTargetSubStatationFlag = true;
                    }, retryToPLCTimer);
                    this.targetSubStationCount++;
                    this.postDatatoSocketPLCWrite(staticTags.TARGETSUBSTATION_TAG, this.targetSubStation);

                } else if (!isValid && this.targetSubStationCount === feebackWriteCount) {
                    log.error(`${MESSAGESCODE.XXX05024}`);
                    this.writeMessageToKafka(plcdata, "XXX05024")
                    this.writeTargetSubStatationFlag = false;
                } else if (isValid) {
                    // if all ok then stop validation
                    this.writeTargetSubStatationFlag = false;
                    this.setCheckInResultFlag();
                }
            }
            // check processdata
            if (this.writeProcessDataFlag) {
                const isValid = this.validateProcessData(data);
                if (!isValid && this.processdataCount < feebackWriteCount) {
                    clearTimeout(this.writeProcessDataTimer);
                    this.writeProcessDataFlag = false;
                    // plc polling is reduced to 50 ms
                    this.writeProcessDataTimer = setTimeout(() => {
                        this.writeProcessDataFlag = true;
                    }, retryToPLCTimer);
                    this.processdataCount++;
                    this.writeProcessData();
                } else if (!isValid && this.processdataCount === feebackWriteCount) {
                    log.error('Write Process Data Error');
                    this.writeProcessDataFlag = false;
                } else if (isValid) {
                    // if all ok then stop validation
                    this.writeProcessDataFlag = false;
                    this.writeTargetSubStatationFlag = true;
                }
            }
            // check virtualmainid
            if (this.writeVirtualMainIdFlag) {
                // if virtualMainId value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = this.virtualMainId === data[staticTags.VIRTUALMAINID_TAG] ? true : false;
                if (!isValid && this.mainIdCount < feebackWriteCount) {
                    clearTimeout(this.mainidTimer);
                    this.writeVirtualMainIdFlag = false;
                    // plc polling is reduced to 50 ms
                    this.mainidTimer = setTimeout(() => {
                        this.writeVirtualMainIdFlag = true;
                    }, retryToPLCTimer);
                    this.mainIdCount++;
                    this.postDatatoSocketPLCWrite(staticTags.VIRTUALMAINID_TAG, this.virtualMainId);

                } else if (!isValid && this.mainIdCount === feebackWriteCount) {
                    log.error(`${MESSAGESCODE.XXX05025}`);
                    this.writeMessageToKafka(plcdata, "XXX05025")
                    this.writeVirtualMainIdFlag = false;
                } else if (isValid) {
                    log.error(`Write VirtualMainID : ${this.virtualMainId}`);
                    // if all ok then stop validation
                    this.writeVirtualMainIdFlag = false;
                    this.writeTargetSubStatationFlag = true;
                }
            }
            // check CheckInNGCode
            if (writeCheckInNGCodeFlag) {
                // if CheckInNGCode value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = CheckInNGCode === data[staticTags.CHECKINNGCODE_TAG] ? true : false;
                if (!isValid && CheckInNGCodeCount < feebackWriteCount) {
                    clearTimeout(writeCheckInNGCodeTimer);
                    this.resetCheckInNGCodeFlag()
                    // plc polling is reduced to 50 ms
                    writeCheckInNGCodeTimer = setTimeout(() => {
                        this.setCheckInNGCodeFlag()
                    }, retryToPLCTimer);
                    CheckInNGCodeCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKINNGCODE_TAG, CheckInNGCode);

                } else if (!isValid && CheckInNGCodeCount === feebackWriteCount) {
                    log.error(`${MESSAGESCODE.XXX05026}`);
                    this.writeMessageToKafka(plcdata, "XXX05026")
                    // after 3 times retry error in writing to PLC
                    this.resetCheckInNGCodeFlag();
                } else if (isValid) {
                    // if all ok then stop validation
                    this.resetCheckInNGCodeFlag();

                }
            }
            // check CheckInProcessCode
            if (writeCheckInProcessCodeFlag) {
                // if CheckInProcessCode value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = CheckInProcessCode === data[staticTags.PROCESSCODE_TAG] ? true : false;
                if (!isValid && CheckInProcessCodeCount < feebackWriteCount) {
                    clearTimeout(writeCheckInProcessCodeTimer);
                    this.resetCheckInProcessCodeFlag();
                    // plc polling is reduced to 50 ms
                    writeCheckInProcessCodeTimer = setTimeout(() => {
                        this.setCheckInProcessCodeFlag();
                    }, retryToPLCTimer);
                    CheckInProcessCodeCount++;
                    this.postDatatoSocketPLCWrite(staticTags.PROCESSCODE_TAG, CheckInProcessCode);

                } else if (!isValid && CheckInProcessCodeCount === feebackWriteCount) {
                    log.error(`${MESSAGESCODE.XXX05027}`);
                    this.writeMessageToKafka(plcdata, "XXX05027")
                    // after 3 times retry error in writing to PLC
                    this.resetCheckInProcessCodeFlag();

                } else if (isValid) {
                    // if all ok then stop validation
                    this.resetCheckInProcessCodeFlag();
                }
            }
            // CheckInCompleted
            if (writeCheckInCompletedFlag) {
                const isValid = CheckInCompleted === data[staticTags.CHECKINCOMPLETED_TAG] ? true : false;
                if (!isValid && CheckInCompleteCount < feebackWriteCount) {
                    clearTimeout(writeCheckInCompleteTimer);
                    writeCheckInCompletedFlag = false;
                    // plc polling is reduced to 50 ms
                    writeCheckInCompleteTimer = setTimeout(() => {
                        writeCheckInCompletedFlag = true;
                    }, retryToPLCTimer);

                    CheckInCompleteCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKINCOMPLETED_TAG, CheckInCompleted);

                } else if (!isValid && CheckInCompleteCount === feebackWriteCount) {
                    log.error(`${MESSAGESCODE.XXX05028}`);
                    this.writeMessageToKafka(plcdata, "XXX05028")
                    // after 3 times retry error in write CheckInCompleted on PLC
                    writeCheckInCompletedFlag = false;
                    // reset checkincompleted

                } else if (isValid) {
                    // CheckInCompleted written successfully on PLC
                    writeCheckInCompletedFlag = false;
                    // reset checkincompleted
                }
            }
        },
        /**
         * Reset the values i.e. who write who reset
         * @param {Object} data
         */
        resetAck(data) {
            let plcdata = data;
            // reset checkinresult, checkinng, checkinprocesscode and checkincompleted
            const isCheckInCompleted = 0 === data[staticTags.CHECKINCOMPLETED_TAG] ? true : false;
            // wait for 2 seconds and then reset values
            if (!this.reset && resetCheckInCompletedFlag) {
                this.reset = true;
                setTimeout(() => {
                    this.write = true;
                }, resetValueDealyTime * 1000);
            } else if (this.write && resetCheckInCompletedFlag) {
                // reset CheckInCompleted
                if (resetCheckInCompletedFlag && !isCheckInCompleted && resetCheckInCompletedCount < feebackWriteCount) {
                    clearTimeout(this.resetCheckinCompletedTimer);
                    resetCheckInCompletedFlag = false;
                    // plc polling is reduced to 50 ms
                    this.resetCheckinCompletedTimer = setTimeout(() => {
                        resetCheckInCompletedFlag = true;
                    }, retryToPLCTimer);
                    resetCheckInCompletedCount++;
                    this.virtualMainId = '';
                    this.targetSubStation = 0;
                    this.processdata = [];
                    this.postDatatoSocketPLCWrite(staticTags.TARGETSUBSTATION_TAG, this.targetSubStation);
                    CheckInResult = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);
                    CheckInNGCode = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKINNGCODE_TAG, CheckInNGCode);
                    CheckInProcessCode = 0;
                    this.postDatatoSocketPLCWrite(staticTags.PROCESSCODE_TAG, CheckInProcessCode);
                    CheckInCompleted = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKINCOMPLETED_TAG, CheckInCompleted);

                } else if (!isCheckInCompleted && resetCheckInCompletedCount === feebackWriteCount) {
                    log.error(`${MESSAGESCODE.XXX05029}`);
                    this.writeMessageToKafka(plcdata, "XXX05029")
                    resetCheckInCompletedCount++;
                    // after 3 times retry error in write reset values on PLC
                    resetCheckInCompletedFlag = false;

                } else if (isCheckInCompleted) {
                    // reset values written successfully on PLC
                    resetCheckInCompletedFlag = false;
                }
            }
        },
        /**
         * This method check the checkin conditions for Init Station
         * @param {Object} data
         */
        async CommonCheckInInit(plcdata) {
            const isOrder = this.checkOrder(plcdata);
            if (!isOrder) {
                return;
            }
            const runningOrder = ORDER.runningOrder[0];
            const isRework = plcdata[staticTags.REWORKHANDLINGTRIGGER_TAG] || 0;
            if (mainidConfig.virtualmainid && isRework == 0) {
                // generate new virtualmainid
                const result = await new Promise((resolve) => {
                    VIRTUALMAINID.generateVirtualMainId(resolve, runningOrder.orderdata);
                })
                if (result.state) {
                    plcdata[staticTags.MAINID_TAG] = result.data;
                    VIRTUALMAINID.mainid = result.data;
                } else {
                    log.error(result.msg);
                    CheckInResult = CheckInResultValues.ERROR;
                    plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                    plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                    plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                    // write checkin result to checkin element
                    this.writeRecordInSWX(plcdata, runningOrder);
                    return;
                }
            }
            const isMainID = this.checkMainId(plcdata);
            if (isMainID) {
                // const isProductTypeName = this.checkProductTypeName(plcdata);
                // if (isProductTypeName) {

                // }
                this.CheckInMainIDInitStation(plcdata, runningOrder);
            }
        },
        /**
         * This method check the checkin process for Init Station
         * @param {Object} plcdata
         */
        CheckInMainIDInitStation(plcdata, runningOrder) {

            this.getRecordForMainIDInInitStation(plcdata, runningOrder);

        },
        /**
         * This method check the roadmaptype and last substation for mainid
         * @param {Object} plcdata
         * @param {Object} currentStationRecord
         */
        async getRecordForMainIDInInitStation(plcdata, runningOrder) {
            // check the substationid is presnt in roadmap type / mode status or not in current running order
            let roadmapType = runningOrder.orderdata[orderdetailsTags.ROADMAPTYPE_TAG];
            if (!roadmapType) {
                // bypass
                log.error(`Init Station Roadmap Type not found`);
                CheckInResult = CheckInResultValues.BYPASS;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.BYPASS;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder, runningOrder.runningRoadMap);
            } else {
                //if substation present in roadmap then do following steps
                // check the status of last substation for mainid and ordername
                const elementName = elements.partstatus || 'partstatus';
                try {
                    // TODO Add query to get the running order
                    const ordername = runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG];
                    // no need to add query for stationid we need to check the last substation result
                    /*
                        query = `query=lineid==1%26%26mainid=="MainId1"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
                    */
                    let query = `query=${[checkoutTags.LINEID_TAG]}==${lineid}`;
                    query += `%26%26${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.MAINID_TAG]}"`;
                    query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                    log.trace(`Check Part Status in Init Station query : ${query}`)
                    const response = await elementService.getElementRecords(elementName, query)
                    if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                        if (response.data && response.data.results && response.data.results.length > 0) {
                            // check the last substation result for mainid and orderid
                            this.checkOverAllResult(plcdata, runningOrder, response.data.results[0]);
                        } else {
                            // const isOrderAchive = this.checkOrderActualQuantity(plcdata, runningOrder);
                            const isOrderAchive = true;
                            if (isOrderAchive) {
                                const isRoadMap = this.checkRoadMap(plcdata, runningOrder.runningRoadMap, runningOrder);
                                if (isRoadMap) {
                                    const isRecipe = this.checkRecipe(plcdata, runningOrder);
                                    if (isRecipe) {
                                        CheckInNGCode = 0;
                                        this.setCheckInNGCodeFlag();
                                        // write processcode for init station
                                        if (plcdata[staticTags.PROCESSCODE_TAG] != undefined && runningOrder.runningRoadMap.length > 0 && runningOrder.runningRoadMap[0][roadmapTags['PROCESSCODE_TAG']] !== undefined) {
                                            CheckInProcessCode = runningOrder.runningRoadMap[0][roadmapTags['PROCESSCODE_TAG']];
                                            this.setCheckInProcessCodeFlag();
                                            this.postDatatoSocketPLCWrite(staticTags.PROCESSCODE_TAG, CheckInProcessCode);
                                        }
                                        CheckInResult = CheckInResultValues.OK;
                                        plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                                        plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                                        plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.OK;
                                        // write checkin result to checkin element
                                        this.writeRecordInSWX(plcdata, runningOrder, runningOrder.runningRoadMap);
                                    }
                                }
                            }
                        }
                    } else {
                        log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`);
                        // no record found for mainid and ordername
                        CheckInResult = CheckInResultValues.ERROR;
                        plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                        plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                        plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                        // write checkin result to checkin element
                        this.writeRecordInSWX(plcdata, runningOrder);
                    }
                } catch (ex) {
                    log.error(`Exception to fetch data for element : ${elementName}`);
                    const messageObject = ex.response ? ex.response.data : ex
                    log.error(messageObject);
                    // no record found for mainid and ordername
                    CheckInResult = CheckInResultValues.ERROR;
                    plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                    plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                    plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                    // write checkin result to checkin element
                    this.writeRecordInSWX(plcdata, runningOrder);
                }
            }
        },

        /**
         * This method check the CheckIn Process for normal stations
         * @param {Object} data
         */
        async CommonCheckInNormalOrFinal(plcdata) {
            const isOrder = this.checkOrder(plcdata);
            if (!isOrder) {
                return;
            }
            // check MAINID/CARRIERID Present or Not
            // const runningOrder = ORDER.runningOrder;
            const isMainID = this.checkMainId(plcdata);
            if (isMainID) {
                // const isProductTypeName = this.checkProductTypeName(plcdata);
                // if (isProductTypeName) {
                //     this.CheckInMainIDNormaOrFinalStation(plcdata);
                // }
                this.CheckInMainIDNormaOrFinalStation(plcdata);
            }
        },
        /**
         * This method check the CheckInMainIDNormaOrFinalStation and it is same as CheckInMainIDInitStation
         * Refering common logic for it
         * @param {*} data
         */
        CheckInMainIDNormaOrFinalStation(plcdata) {
            // The further process is same as CheckInMainIDInitStation
            this.checkLastStationPartStatusNormalFinal(plcdata);
        },

        async checkLastStationPartStatusNormalFinal(plcdata) {
            const elementName = elements.partstatus || 'partstatus';
            try {

                // const ordername = runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG];
                // no need to add query for stationid we need to check the last substation result
                /*
                    query = `query=lineid==1%26%26mainid=="MainId1"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
                */
                let query = `query=${[checkoutTags.LINEID_TAG]}==${lineid}`;
                query += `%26%26${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.MAINID_TAG]}"`;
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                log.trace(`Check Part Status in Last Station query : ${query}`)
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        const mainidOrder = ORDER.runningOrder.filter((item) => {
                            const { orderdata } = item;
                            return response.data.results[0][orderdetailsTags.ORDERNAME_TAG] === orderdata[orderdetailsTags.ORDERNAME_TAG];
                        });
                        if (mainidOrder.length > 0) {
                            const runningOrder = mainidOrder[0];
                            let roadmapType = runningOrder.orderdata[orderdetailsTags.ROADMAPTYPE_TAG];
                            if (!roadmapType) {
                                // bypass
                                log.error(`Normal/Final Station Roadmap Type not found`);
                                CheckInResult = CheckInResultValues.BYPASS;
                                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.BYPASS;
                                // write checkin result to checkin element
                                this.writeRecordInSWX(plcdata, runningOrder, runningOrder.runningRoadMap);
                                // do nothing next
                                return;
                            }
                            // check the last substation result for mainid and orderid
                            this.checkOverAllResult(plcdata, runningOrder, response.data.results[0]);
                        }
                        else {
                            log.error(`No RunningOrder found for mainid ${plcdata[staticTags.MAINID_TAG]}`);
                            CheckInResult = CheckInResultValues.ORDERNOK;
                            plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                            plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                            plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ORDERNOK;
                            // write checkin result to checkin element
                            this.writeRecordInSWX(plcdata, {});
                        }
                    } else {
                        log.error(`No record found in partstatus for mainid ${plcdata[staticTags.MAINID_TAG]}`);
                        CheckInResult = CheckInResultValues.ERROR;
                        plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                        plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                        plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                        // write checkin result to checkin element
                        this.writeRecordInSWX(plcdata, {});
                    }
                } else {
                    utility.checkSessionExpired(response.data);
                    log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`);
                    CheckInResult = CheckInResultValues.ERROR;
                    plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                    plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                    plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                    // write checkin result to checkin element
                    this.writeRecordInSWX(plcdata, {});
                }
            } catch (ex) {
                log.error(`Exception to fetch data for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                CheckInResult = CheckInResultValues.ERROR;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, {});
            }
        },

        /**
         * This method check the status of last substation mainid processed
         * @param {*} plcdata
         * @param {*} lastStationData
         */
        async checkOverAllResult(plcdata, runningOrder, lastStationData) {
            const ordername = runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG];
            // check the mainid is already processed or not and check the order of that record with running order
            if (ordername != lastStationData[checkoutTags.ORDERNAME_TAG]) {
                log.error(`${MESSAGESCODE.XXX03003} for ${plcdata[staticTags.MAINID_TAG]}`);
                this.writeMessageToKafka(plcdata, "XXX03003")
                CheckInResult = CheckInResultValues.DIFFERNTORDER;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ORDERNOK;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);
                return;
            }
            let runningRoadMap = runningOrder.runningRoadMap;
            if (lastStationData[checkoutTags.MODESTATUS_TAG] && lastStationData[checkoutTags.MODESTATUS_TAG] != defaults.normalmodestatus) {
                const result = await ORDER.getRoadMapForRework(lastStationData);
                runningRoadMap = result;
            }
            // write processcode for normal or final station
            if (plcdata[staticTags.PROCESSCODE_TAG] != undefined && runningRoadMap.length > 0 && runningRoadMap[0][roadmapTags['PROCESSCODE_TAG']] !== undefined) {
                CheckInProcessCode = runningRoadMap[0][roadmapTags['PROCESSCODE_TAG']];
                this.setCheckInProcessCodeFlag();
                this.postDatatoSocketPLCWrite(staticTags.PROCESSCODE_TAG, CheckInProcessCode);
            }
            const status = lastStationData[checkoutTags.OVERALLRESULT_TAG];
            if (status === CheckInResultValues.NG) {
                // ng status
                // BUG RA-I467
                if (lastStationData[checkoutTags.SUBSTATIONID_TAG] === substationid) {
                    log.error(`${MESSAGESCODE.XXX03030}`);
                    this.writeMessageToKafka(plcdata, "XXX03030")
                    CheckInResult = CheckInResultValues.CURRENTSTATIONNG
                } else {
                    log.error(`${MESSAGESCODE.XXX03004}`);
                    this.writeMessageToKafka(plcdata, "XXX03004")
                    CheckInResult = CheckInResultValues.NG;
                }

                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.NG;
                CheckInNGCode = lastStationData[checkoutTags.CHECKOUTNGCODE_TAG];
                this.setCheckInNGCodeFlag();
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                this.postDatatoSocketPLCWrite(staticTags.CHECKINNGCODE_TAG, CheckInNGCode);
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);

            } else if (status === CheckInResultValues.ERROR) {
                log.error(`${MESSAGESCODE.XXX03005}`);
                this.writeMessageToKafka(plcdata, "XXX03005")
                // unknown status
                CheckInResult = CheckInResultValues.ERROR;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);

            } else if (status === CheckInResultValues.COMPLETED) {
                log.error(`${MESSAGESCODE.XXX03005}`);
                this.writeMessageToKafka(plcdata, "XXX03005")
                // completed status
                CheckInResult = CheckInResultValues.COMPLETED;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.COMPLETED;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);

            } else if (status === CheckInResultValues.TESTFAILED) {
                log.error(`${MESSAGESCODE.XXX03006}`);
                this.writeMessageToKafka(plcdata, "XXX03006")
                // testfailed status
                CheckInResult = CheckInResultValues.TESTFAILED;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.TESTFAILED;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);

            } else if (status === CheckInResultValues.OK) {
                // check the substationid is present in roadmap or not
                log.error(`${MESSAGESCODE.XXX03007}`);
                this.writeMessageToKafka(plcdata, "XXX03007")
                // not execute the if condition logic any more remove after testing
                // check number of pre substation amount here
                if (runningRoadMap.length === 0) {
                    // bypass
                    log.error(`${MESSAGESCODE.XXX03010}`);
                    this.writeMessageToKafka(plcdata, "XXX03010")
                    CheckInResult = CheckInResultValues.BYPASS;
                    // do nothing next
                    plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                    plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                    plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.BYPASS;
                    // write checkin result to checkin element
                    const targetSubstation = await this.getTargetSubStationForSubstation(runningRoadMap, lastStationData, runningOrder);
                    this.writeRecordInSWX(plcdata, runningOrder, targetSubstation);
                } else {
                    // TODO normal and final station check previous station in current roadmap
                    let isProcessed = false;
                    let presubstation = 0;
                    for (var i = 0; i < runningRoadMap.length; i++) {
                        if (runningRoadMap[i][roadmapTags.PRESUBSTATIONID_TAG]) {
                            presubstation++;
                        }
                        if (lastStationData[checkoutTags.SUBSTATIONID_TAG] === runningRoadMap[i][roadmapTags.PRESUBSTATIONID_TAG]) {
                            isProcessed = true;
                        }
                    }
                    if (isProcessed) {
                        // no need to check previous stations we are checking last update part status
                        // write checkin result to checkin element
                        const isRoadMap = this.checkRoadMap(plcdata, runningRoadMap, lastStationData, runningOrder);
                        if (isRoadMap) {
                            const isRecipe = this.checkRecipe(plcdata, runningOrder);
                            if (isRecipe) {
                                CheckInResult = CheckInResultValues.OK;
                                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.OK;
                                const targetSubstation = await this.getTargetSubStationForSubstation(runningRoadMap, lastStationData, runningOrder);
                                this.writeRecordInSWX(plcdata, runningOrder, targetSubstation);
                            }
                        }
                    } else {
                        if (presubstation == 0) {
                            if (!lastStationData[checkoutTags.SUBSTATIONID_TAG]) {
                                log.error(`Laststation result does not contain substationid and presubstation is 0 OK ${CheckInResultValues.OK}`);
                                CheckInResult = CheckInResultValues.OK;
                                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.OK;
                            }
                            else {
                                // bypass
                                log.error(`${MESSAGESCODE.XXX03011}`);
                                this.writeMessageToKafka(plcdata, "XXX03011")
                                CheckInResult = CheckInResultValues.BYPASS;
                                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.BYPASS;
                            }

                        } else {
                            // bypass
                            log.error(`Main Id not processed in pre substation`);
                            log.error(`${MESSAGESCODE.XXX03012}`);
                            this.writeMessageToKafka(plcdata, "XXX03012")
                            CheckInResult = CheckInResultValues.BYPASS;
                            plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                            plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                            plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.BYPASS;
                            // write checkin result to checkin element
                        }
                        const targetSubstation = await this.getTargetSubStationForSubstation(runningRoadMap, lastStationData, runningOrder);
                        this.writeRecordInSWX(plcdata, runningOrder, targetSubstation);
                    }
                }
            } else {
                log.error(`${MESSAGESCODE.XXX03013}`);
                this.writeMessageToKafka(plcdata, "XXX03013")
                CheckInResult = CheckInResultValues.ERROR;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);
            }
        },

        async getTargetSubStationForSubstation(runningRoadMap, lastStationData, runningOrder) {
            let targetSubstation = [];
            // get Target substation
            const lastSubstationid = lastStationData[checkoutTags.SUBSTATIONID_TAG];
            const roadmapid = lastStationData[checkoutTags.ROADMAPID_TAG] || runningOrder.orderdata[orderdetailsTags.ROADMAPID_TAG];
            if (lastSubstationid && (CheckInResult === CheckInResultValues.OK || CheckInResult === CheckInResultValues.BYPASS)) {
                targetSubstation = await ORDER.getTargetSubStationForSubstation(roadmapid, lastSubstationid);
            } else {
                // find the substation which does not have presubstation for writing target substation
                let targetSubstationInfo = await ORDER.getTargetSubStationForSubstation(roadmapid);
                for (var i = 0; i < targetSubstationInfo.length; i++) {
                    if (!targetSubstationInfo[i][roadmapTags.PRESUBSTATIONID_TAG]) {
                        targetSubstation.push(targetSubstationInfo[i]);
                    }
                }
                if (targetSubstation.length === 0) {
                    targetSubstation = runningRoadMap;
                }
            }
            return targetSubstation;
        },
        /**
         * This method check the mainid is presnt in plc data or not
         * @param {Object} plcdata
         */
        checkMainId(plcdata) {
            // const runningOrder = ORDER.runningOrder;
            if (plcdata[staticTags.MAINID_TAG]) {
                // MAINID/CARRIERID Present in PLC data
                log.error(`MainID present in PLC data`);
                return true;
            } else {
                // MAINID not present
                log.error(`${MESSAGESCODE.XXX03014}`);
                this.writeMessageToKafka(plcdata, "XXX03014")
                CheckInResult = CheckInResultValues.ERROR;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata);
                return false;
            }
        },
        /**
         * This method check the Order is running or not
         * @param {Object} plcdata
         */
        checkOrder(plcdata) {
            const runningOrder = ORDER.runningOrder;
            if (runningOrder.length === 0) {
                log.error(`${MESSAGESCODE.XXX03016}`);
                this.writeMessageToKafka(plcdata, "XXX03016")
                CheckInResult = CheckInResultValues.ORDERNOK
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ORDERNOK;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);
                return false;
            }
            return true;
        },
        /**
         * This method checks Product Type Name is matched with PLC data or not
         * @param {Object} plcdata
         */
        checkProductTypeName(plcdata) {
            const runningOrder = ORDER.runningOrder;
            if (runningOrder && runningOrder.length > 0 && runningOrder.orderdata[orderdetailsTags.PRODUCTTYPENAME_TAG] === plcdata[staticTags.PRODUCTTYPENAME_TAG]) {
                // ProductTypeName matched with Order Proceed for next step of checking recipename present in Order or not
                // proceed next
                log.error(`Product Type Name matched with Order`);
                return true;
            } else {
                log.error(`${MESSAGESCODE.XXX03017} with ${plcdata[staticTags.PRODUCTTYPENAME_TAG]}`);
                this.writeMessageToKafka(plcdata, "XXX03017")
                CheckInResult = CheckInResultValues.TYPENOK
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.TYPENOK;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);
                // complete the CheckIn Process
                return false;
            }
        },
        /**
         * This method check the ORDER count equal to target count
         * @param {Object} plcdata
         * @param {Object} runningOrder
         */
        checkOrderActualQuantity(plcdata, runningOrder) {
            if (runningOrder) {
                if (runningOrder.ordercount >= runningOrder.orderdata[orderdetailsTags.TARGETCOUNT_TAG] && substation[substationTags.ISMAINLINE_TAG]) {
                    log.error(`${MESSAGESCODE.XXX03018}`);
                    this.writeMessageToKafka(plcdata, "XXX03018")
                    CheckInResult = CheckInResultValues.TARGETCOUNTREACHED;
                    plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                    plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                    plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.TARGETCOUNTREACHED;
                    // write checkin result to checkin element
                    this.writeRecordInSWX(plcdata, runningOrder);
                    return false;
                }
            }
            return true;
        },
        /**
         * This method check the Roadmap is present or not for the substation
         * @param {Object} plcdata
         */
        async checkRoadMap(plcdata, runningRoadMap, lastStationData, runningOrder) {
            // const runningOrder = ORDER.runningOrder;
            if (!substation[substationTags.INITIALSUBSTATION_TAG] && runningRoadMap.length === 0) {
                log.error(`${MESSAGESCODE.XXX03019}`);
                this.writeMessageToKafka(plcdata, "XXX03019")
                CheckInResult = CheckInResultValues.BYPASS;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.BYPASS;
                // write checkin result to checkin element
                if (lastStationData) {
                    const targetSubstation = await this.getTargetSubStationForSubstation(runningRoadMap, lastStationData);
                    this.writeRecordInSWX(plcdata, runningOrder, targetSubstation);
                } else {
                    this.writeRecordInSWX(plcdata, runningOrder, runningRoadMap);
                }
                return false;
            }
            return true;
        },
        /**
         * This method check the recipename in order is matched with plc data or not
         * @param {Object} plcdata
         */
        checkRecipe(plcdata, runningOrder) {
            // const orderProduct = ORDER.orderProduct;
            // const runningOrder = ORDER.runningOrder;
            const { orderProduct } = runningOrder;
            if ((orderProduct && orderProduct.length > 0 && !orderProduct[0][recipedetailsTags.RECIPENAME_TAG]) || (orderProduct && orderProduct.length > 0 && orderProduct[0][recipedetailsTags.RECIPENAME_TAG] === plcdata[staticTags.RECIPENAME_TAG])) {
                log.error(`Recipe Matched with Order Recipe Name`);
                return true;
            } else {
                log.error(`${MESSAGESCODE.XXX03020} with ${plcdata[staticTags.RECIPENAME_TAG]}`);
                this.writeMessageToKafka(plcdata, "XXX03020")
                CheckInResult = CheckInResultValues.RECIPENOK;
                // complete the CheckIn Process
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.RECIPENOK;
                // write checkin result to checkin element
                this.writeRecordInSWX(plcdata, runningOrder);
                return false;
            }
        },
        /**
         * This method get the 0th pre-substation substationid and return it
         */
        getTargetSubStationID(arrayOfTargetSubstationID) {
            let substationID = '';
            if (arrayOfTargetSubstationID.length > 0) {
                substationID = arrayOfTargetSubstationID[0][roadmapTags.SUBSTATIONID_TAG];
            }
            return substationID;
        },
        /**
         * This method check to write targetSubstation or not based on CheckInResult value
         */
        writeTargetStation(substationID) {
            if (substationID) {
                log.info(`Target substation is ${substationID}`);
                this.writeTargetSubStatationFlag = true;
                this.targetSubStation = +substationID.split('-')[1];
                this.postDatatoSocketPLCWrite(staticTags.TARGETSUBSTATION_TAG, this.targetSubStation);
            } else {
                log.error(`Can not set or write targetsubstation to PLC or in checkin CheckInResult: ${CheckInResult} and targetsubstation : ${substationID}`);
                this.setCheckInResultFlag();
                log.error(`Write Feedback to PLC as ${CheckInResult}`);
                this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);
            }
        },
        /**
         * This method check to write targetSubstation or not based on CheckInResult value
         */
        writeVirtualMainId(mainid) {
            if (mainid) {
                log.error(`mainid is ${mainid}`);
                this.writeVirtualMainIdFlag = true;
                this.virtualMainId = mainid;
                this.postDatatoSocketPLCWrite(staticTags.VIRTUALMAINID_TAG, this.virtualMainId);
            } else {
                log.error(`Can not set or write mainid to PLC`);
                this.setCheckInResultFlag();
                log.error(`Write Feedback to PLC as ${CheckInResult}`);
                this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);
            }
        },
        writeProcessData() {
            this.writeProcessDataFlag = true;
            this.processDataWriteEvent();
        },
        processDataWriteEvent() {
            const data = this.processdata;
            if (data.length) {
                log.error(`Start Write Process Data`);
                log.error(`Process Data: ${JSON.stringify(data)}`);
                for (let i = 0; i < data.length; i++) {
                    this.postDatatoSocketPLCWrite(data[i].name, data[i].value);
                }
                clearTimeout(this.writeProcessDataTimer);
                this.writeProcessDataTimer = setTimeout(() => {
                    this.writeProcessDataFlag = true;
                }, retryToPLCTimer);
            } else {
                log.error(`ProcessData not found`);
            }
        },
        validateProcessData(plcdata) {
            const data = this.processdata;
            if (data.length) {
                const okProcessData = [];
                for (let i = 0; i < data.length; i++) {
                    const name = data[i].name;
                    const value = data[i].value;
                    if (typeof plcdata[name] === 'number') {
                        let decimalpoint = this.countDecimals(value, name, plcdata[name]);
                        plcdata[name] = plcdata[name] ? +plcdata[name].toFixed(decimalpoint) : plcdata[name];
                    }
                    if (value == plcdata[name]) {
                        okProcessData.push({
                            [name]: plcdata[name]
                        });
                    }
                }
                log.error(`ProcessData Valid: ${okProcessData.length === data.length}`);
                return okProcessData.length === data.length;
            } else {
                log.error(`ProcessData not found`);
                return false;
            }
        },
        countDecimals(value, param, plcval) {
            try {
                if (Math.floor(value) === value) return 0;
                return value.toString().split(".")[1].length || 0;
            } catch (ex) {
                log.error(`Exeption in checking decimalcount parametername : ${param}, recipevalue : ${value}, plcvalue : ${plcval}`);
            }
            return value;
        },
        /**
         * This method write the checkout result in ShopWorx database
         * @param {Object} plcdata
         * @param {Array} runningOrder
         */
        async writeRecordInSWX(data, runningOrder, targetSubStation) {
            let plcdata = utility.cloneDeep(data);
            if (runningOrder && runningOrder.orderdata) {
                plcdata = { ...runningOrder.orderdata, ...plcdata };
            }
            plcdata[checkinTags.LINEID_TAG] = lineid;
            plcdata[checkinTags.SUBLINEID_TAG] = sublineid;
            plcdata[checkinTags.SUBSTATIONID_TAG] = substationid;
            plcdata[checkinTags.SUBSTATIONNAME_TAG] = substationname;
            delete plcdata[staticTags.TARGETSUBSTATION_TAG];
            if (targetSubStation) {
                plcdata[checkinTags.TARGETSUBSTATION_TAG] = this.getTargetSubStationID(targetSubStation);
            }
            let payload = utility.assignDataToSchema(plcdata, checkinSchema)
            payload.assetid = substation.assetid;
            log.trace(`Checkin Payload ${JSON.stringify(payload)}`);
            const elementName = elements.checkin || 'checkin'
            try {
                const response = await elementService.createElementRecord(elementName, payload);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Checkin Record saved successfully in ShopWorx ${JSON.stringify(response.data)}`);
                    if (mainidConfig.mainidbindcarrierid && substation[substationTags.INITIALSUBSTATION_TAG] && CheckInResult == CheckInResultValues.OK) {
                        const mainid = plcdata[staticTags.MAINID_TAG];
                        const carrierid = plcdata[staticTags.CARRIERID_TAG];
                        const result = await new Promise((resolve) => {
                            VIRTUALMAINID.bindMainIdWithCarrierID(mainid, carrierid, resolve)
                        });
                        if (result.state) {
                            log.error(`mainid: ${mainid} bind with carrierid: ${carrierid}`)
                        } else {
                            log.error(result.msg);
                            CheckInResult = CheckInResultValues.ERROR;
                            this.setCheckInResultFlag();
                            log.error(`Write Feedback to PLC as ${CheckInResult}`);
                            this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);
                            return;
                        }
                    }
                    if (mainidConfig.writevirtualmainidtoplc) {
                        const substationID = plcdata[checkinTags.TARGETSUBSTATION_TAG];
                        if (plcdata[checkinTags.TARGETSUBSTATION_TAG]) {
                            this.targetSubStation = +substationID.split('-')[1];
                            this.writeVirtualMainId(plcdata[staticTags.MAINID_TAG])
                        } else {
                            log.error(`Can not set or write targetsubstation to PLC or in checkin CheckInResult: ${CheckInResult} and targetsubstation : ${substationID}`);
                            this.setCheckInResultFlag();
                            log.error(`Write Feedback to PLC as ${CheckInResult}`);
                            this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);
                        }
                    } else {
                        if (mainidConfig.writelastprocessdatatoplc && CheckInResult == CheckInResultValues.OK) {
                            const substationID = plcdata[checkinTags.TARGETSUBSTATION_TAG];
                            const result = await new Promise((resolve) => {
                                this.generateProcessData(plcdata, resolve);
                            });
                            if (result.state) {
                                // write processdata
                                this.processdata = result.data;
                                this.targetSubStation = +substationID.split('-')[1];
                                log.error(this.processdata);
                                this.writeProcessData();
                            } else {
                                this.writeTargetStation(plcdata[checkinTags.TARGETSUBSTATION_TAG]);
                            }
                        } else {
                            this.writeTargetStation(plcdata[checkinTags.TARGETSUBSTATION_TAG]);
                        }
                    }
                } else {
                    utility.checkSessionExpired(response.data);
                    log.error(`${MESSAGESCODE.XXX03021}`);
                    this.writeMessageToKafka(plcdata, "XXX03021")
                    log.error(`Error in writing Checkin result in ShopWorx ${JSON.stringify(response.data)}`);
                    CheckInResult = CheckInResultValues.SAVEDATAERROR;
                    this.setCheckInResultFlag();
                    log.error(`Write Feedback to PLC as ${CheckInResult}`);
                    this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);
                }
            } catch (ex) {
                log.error(`${MESSAGESCODE.XXX03022} ${ex}`);
                this.writeMessageToKafka(plcdata, "XXX03022")
                CheckInResult = CheckInResultValues.SAVEDATAERROR;
                this.setCheckInResultFlag();
                log.error(`Write Feedback to PLC as ${CheckInResult}`);
                this.postDatatoSocketPLCWrite(staticTags.CHECKINRESULT_TAG, CheckInResult);
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
            log.info(`PLC Write Payload ${JSON.stringify(payload)}`);
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
        },
        async generateProcessData(plcdata, resolve) {
            let recipe = [];
            if (substationid === 'substation-250') {
                recipe = [
                    {
                        name: 'substation-263_90damperid',
                        writename: '150shockbarcode'
                    },
                ];
            } else {
                resolve({
                    state: false,
                    data: processdata
                });
                return;
            }
            // Get traceability Data
            let query = `query=${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.MAINID_TAG]}"`;
            query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
            const response = await elementService.getElementRecords(elements.traceability || 'traceability', query);
            if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                if (response.data && response.data.results && response.data.results.length > 0) {
                    const traceabilitydata = response.data.results[0];
                    const processdata = recipe.map((item) => {
                        return {
                            name: item.writename,
                            value: traceabilitydata[item.name] || 0
                        };
                    });
                    resolve({
                        state: true,
                        data: processdata
                    });
                } else {
                    log.error(`No record found in checkout for traceability ${plcdata[staticTags.MAINID_TAG]}`);
                    CheckInResult = CheckInResultValues.ERROR;
                    plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                    plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                    plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                    resolve({
                        state: false,
                    });
                }
            } else {
                utility.checkSessionExpired(response.data);
                log.error(`Error in getting  processdata from elementName : traceability ${JSON.stringify(response.data)}`);
                CheckInResult = CheckInResultValues.ERROR;
                plcdata[checkinTags['CHECKINNGCODE_TAG']] = CheckInNGCode || 0;
                plcdata[checkinTags['PROCESSCODE_TAG']] = CheckInProcessCode || 0;
                plcdata[checkinTags['CHECKINRESULT_TAG']] = CheckInResultValues.ERROR;
                resolve({
                    state: false,
                });
            }
        },
        resetCheckInResultFlag() {
            writeCheckInResultFlag = false;
        },
        setCheckInResultFlag() {
            writeCheckInResultFlag = true;
        },
        resetCheckInNGCodeFlag() {
            writeCheckInNGCodeFlag = false;
        },
        setCheckInNGCodeFlag() {
            writeCheckInNGCodeFlag = true;
        },
        resetCheckInProcessCodeFlag() {
            writeCheckInProcessCodeFlag = false;
        },
        setCheckInProcessCodeFlag() {
            writeCheckInProcessCodeFlag = true;
        },
        /**
         * Reset All flag when checkin triggered
         */
        restAllFlag() {
            writeCheckInNGCodeFlag = false;
            writeCheckInProcessCodeFlag = false;
            writeCheckInResultFlag = false;
            this.writeTargetSubStatationFlag = false;
            this.writeVirtualMainIdFlag = false;
        },
        writeMessageToKafka(plcdata, logcode) {
            let Obj = {
                timestamp: plcdata.timestamp,
                logtype: "ERROR",
                logcode: logcode,
                logsource: config.source,
                assetid: substation.assetid,
                metadata: JSON.stringify(plcdata)
            }
            emitter.emit('logmessage', Obj);
        }
    }
}