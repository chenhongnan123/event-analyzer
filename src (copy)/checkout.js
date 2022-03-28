'use strict'
module.exports.checkout = checkout;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const InterfaceService = require('../service/interface.service').InterfaceService;
const bunyan = NodePackage.bunyan;
const CheckOutValues = require('../utils/constant').checkoutresult;
const ComponentValues = require('../utils/constant').componentcheckresult;
const componentparameter = require('./componentparameter');
const processparameter = require('./processparameter');
function checkout(config, substation, PARAMETERS, ORDER, VIRTUALMAINID, utility, tags, MESSAGESCODE, emitter) {
    const substationTags = tags.substationtags;
    const parameterTags = tags.parametertags;
    const orderdetailsTags = tags.orderdetailstags;
    const staticTags = tags.statictags;
    const checkoutTags = tags.checkouttags;
    const componentTags = tags.componenttags;
    const bomDetailsTags = tags.bomdetialsTags;
    const roadmapTags = tags.roadmaptags;
    const socketio = config.feedbacktoplcsocketio;
    const elements = config.elements;
    const defaults = config.defaults;
    const mainidConfig = JSON.parse(substation.jsondata).mainid || {};
    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let substationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    let erpcode = substation[substationTags.ERPCODE_TAG];
    let previousvalidatebit = 0;
    let retryServerTimer = defaults.retryServerTimer; // in seconds
    const feebackWriteCount = defaults.maxPLCRetryCheckoutFeedbackCount;
    const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
    const resetValueDealyTime = defaults.resetValueDealyTime || 2;
    let writeCheckOutResultFlag = false;
    let CheckOutResult;
    let writeCheckOutResultTimer;
    let writeCheckOutCompletedFlag = false;
    let CheckOutCompleted;
    let writeCheckOutCompletedTimer;

    let checkoutCompleteCount = 0;
    let checkoutResultCount = 0;

    let resetCheckOutCompletedFlag = false;
    let resetCheckOutCompletedCount = 0;
    let checkoutSchema = [];
    let partstatusSchema = [];
    let reworkSchema = [];
    const componentParameter = componentparameter.componentparameter(config, substation, PARAMETERS, utility, tags)
    componentParameter.getComponentSchema();
    const processParameter = processparameter.processparameter(config, substation, PARAMETERS, utility, tags, MESSAGESCODE, emitter)
    const log = bunyan.createLogger({ name: `Checkout_${substationid}`, level: config.logger.loglevel });
    return {
        async getCheckoutSchema() {
            const elementName = elements.checkout;
            try {
                const response = await elementService.getElement(elementName)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results) {
                        checkoutSchema = response.data.results.tags;
                    } else {
                        log.error(`Error in getting schema for element : ${elementName}`)
                        utility.checkSessionExpired(response.data);
                        await utility.setTimer(retryServerTimer);
                        await this.getCheckoutSchema();
                    }
                }
            } catch (ex) {
                log.error(`Exception in getting schema for element : ${elementName} ${ex}`);
                await utility.setTimer(retryServerTimer);
                await this.getCheckoutSchema();
            }
        },
        async getPartStatusSchema() {
            const elementName = elements.partstatus;
            try {
                const response = await elementService.getElement(elementName)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results) {
                        partstatusSchema = response.data.results.tags;
                    } else {
                        log.error(`Error in getting schema for element : ${elementName}`)
                        utility.checkSessionExpired(response.data);
                        await utility.setTimer(retryServerTimer);
                        await this.getPartStatusSchema();
                    }
                }
            } catch (ex) {
                log.error(`Exception in getting schema for element : ${elementName} ${ex}`);
                await utility.setTimer(retryServerTimer);
                await this.getPartStatusSchema();
            }
        },
        async getReworkSchema() {
            const elementName = elements.rework;
            try {
                const response = await elementService.getElement(elementName)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results) {
                        reworkSchema = response.data.results.tags;
                    } else {
                        log.error(`Error in getting schema for element : ${elementName}`)
                        utility.checkSessionExpired(response.data);
                        await utility.setTimer(retryServerTimer);
                        await this.getReworkSchema();
                    }
                }
            } catch (ex) {
                log.error(`Exception in getting schema for element : ${elementName} ${ex}`);
                await utility.setTimer(retryServerTimer);
                await this.getReworkSchema();
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
            erpcode = substation[substationTags.ERPCODE_TAG];
            reworkpcode = substation[substationTags.REWORKCODE_TAG];
        },
        processStationData(data1) {
            let data = utility.cloneDeep(data1);
            let removePrefix = 's_';
            let removeParameter = 'q_';
            data = utility.modifyObject(data, removePrefix, removeParameter);
            // check if feedback is written successfully on PLC or not
            if (data[staticTags.CHECKOUTTRIGGER_TAG] === 1) {
                this.CheckOutFeedbacktoPLC(data);
            }
            if (!data[staticTags.CHECKOUTTRIGGER_TAG]) {
                if (previousvalidatebit) {
                    resetCheckOutCompletedFlag = true;
                    resetCheckOutCompletedCount = 0;
                }
                this.resetAck(data);
            }

            if (!data[staticTags.CHECKOUTTRIGGER_TAG]) {
                this.resetAllFlag();
                previousvalidatebit = 0;
            }

            if (previousvalidatebit === 0 && data[staticTags.CHECKOUTTRIGGER_TAG] === 1) {
                log.error(`Checkout Triggered ${JSON.stringify(data)}`);
                previousvalidatebit = 1;
                checkoutCompleteCount = 0;
                checkoutResultCount = 0;
                CheckOutResult = 0;
                resetCheckOutCompletedFlag = false;
                this.targetSubStationCount = 0;
                this.write = false;
                this.reset = false;
                if (substation[substationTags.INITIALSUBSTATION_TAG]) {
                    this.CheckOutMainIDInitStation(data);
                } else if (substation[substationTags.FINALSUBSTATION_TAG]) {
                    this.CheckOutMainIDFinalStation(data);
                } else {
                    this.CheckOutMainIDNormalStation(data);
                }
            }
        },
        /**
         * This method check the mainid present or not in plc data or not
         * If not send error to PLC otherwise process for checking last record
         * @param {Object} data
         */
        async CheckOutMainIDInitStation(data) {
            // check MAINID/CARRIERID Present or Not
            // added check for substationresult discussed with Lukas
            // const runningOrder = ORDER.runningOrder;
            // if (mainidConfig.mainidbindcarrierid) {
            //     const isCarrierID = this.checkCarrierId(data);
            //     if (isCarrierID) {
            //         const carrierid = data[staticTags.CARRIERID_TAG];
            //         const result = await new Promise((resolve) => {
            //             VIRTUALMAINID.checkMainIdByCarrierId(carrierid, resolve)
            //         })
            //         if (result.state) {
            //             data[staticTags.MAINID_TAG] = result.data
            //         } else {
            //             log.error(result.msg);
            //             this.writeRecordInSWX(data, runningOrder, 'ERROR');
            //             return
            //         }
            //     } else {
            //         return;
            //     }
            // }
            const isMainID = this.checkMainId(data);
            if (isMainID) {
                // MAINID/CARRIERID Present in PLC data
                this.getRecordForMainIDInLastStation(data);
            }
        },
        /**
         * This method check Final Stations processing
         * @param {Object} data
         */
        async CheckOutMainIDFinalStation(data) {
            // check MAINID/CARRIERID Present or Not
            // added check for substationresult discussed with Lukas
            // const runningOrder = ORDER.runningOrder;
            // if (mainidConfig.mainidbindcarrierid) {
            //     const isCarrierID = this.checkCarrierId(data);
            //     if (isCarrierID) {
            //         const carrierid = data[staticTags.CARRIERID_TAG];
            //         const result = await new Promise((resolve) => {
            //             VIRTUALMAINID.checkMainIdByCarrierId(carrierid, resolve)
            //         })
            //         if (result.state) {
            //             data[staticTags.MAINID_TAG] = result.data
            //         } else {
            //             log.error(result.msg);
            //             this.writeRecordInSWX(data, runningOrder, 'ERROR');
            //             return;
            //         }
            //     } else {
            //         return;
            //     }
            // }
            const isMainID = this.checkMainId(data);
            if (isMainID) {
                // MAINID/CARRIERID Present in PLC data
                this.getRecordForMainIDInLastStation(data);
            }
        },
        /**
         * This method check Normal Stations processing
         * @param {Object} data
         */
        async CheckOutMainIDNormalStation(data) {
            // check MAINID/CARRIERID Present or Not
            // added check for substationresult discussed with Lukas
            // const runningOrder = ORDER.runningOrder;
            // if (mainidConfig.mainidbindcarrierid) {
            //     const isCarrierID = this.checkCarrierId(data);
            //     if (isCarrierID) {
            //         const carrierid = data[staticTags.CARRIERID_TAG];
            //         const result = await new Promise((resolve) => {
            //             VIRTUALMAINID.checkMainIdByCarrierId(carrierid, resolve)
            //         })
            //         if (result.state) {
            //             data[staticTags.MAINID_TAG] = result.data
            //         } else {
            //             log.error(result.msg);
            //             this.writeRecordInSWX(data, runningOrder, 'ERROR');
            //             return;
            //         }
            //     } else {
            //         return;
            //     }
            // }
            const isMainID = this.checkMainId(data);
            if (isMainID) {
                // MAINID/CARRIERID Present in PLC data
                this.getRecordForMainIDInLastStation(data);
            }
        },
        /**
         * This method check the carrierid is presnt in plc data or not
         * @param {Object} plcdata
         */
        checkCarrierId(plcdata) {
            const runningOrder = ORDER.runningOrder;
            if (plcdata[staticTags.CARRIERID_TAG]) {
                // CARRIERID Present in PLC data
                log.error(`CARRIERID present in PLC data`);
                return true;
            } else {
                // CARRIERID not present
                log.error(`${MESSAGESCODE.XXX05001}`);
                this.writeMessageToKafka(plcdata, "XXX05001")
                this.writeRecordInSWX(plcdata, runningOrder, 'MISSINGDATA');
                return false;
            }
        },
        /**
         * This method check the mainid is presnt in plc data or not
         * @param {Object} plcdata
         */
        checkMainId(plcdata) {
            if (plcdata[staticTags.MAINID_TAG] && plcdata[staticTags.SUBSTATIONRESULT_TAG] !== 0) {
                // MAINID/CARRIERID Present in PLC data
                return true;
            } else {
                // MAINID not present
                if (!plcdata[staticTags.MAINID_TAG]) {
                    log.error(`${MESSAGESCODE.XXX05000}`);
                    this.writeMessageToKafka(plcdata, "XXX05000")
                } else if (plcdata[staticTags.SUBSTATIONRESULT_TAG] == 0) {
                    // TODO Change Code
                    log.error(`SUBSTATIONRESULT ${MESSAGESCODE.XXX05018}`);
                    this.writeMessageToKafka(plcdata, "XXX05018")
                }

                this.writeRecordInSWX(plcdata, {}, 'MISSINGDATA');
                return false;
            }
        },
        /**
         * This method check the last record present in current substation or not
         *
         * If yes then
         *     rework
         * else
         *     fresh
         *
         * @param {Object} data
         * @param {Int} counter
         */
        async getRecordForMainIDInLastStation(data) {
            const elementName = elements.partstatus || 'partstatus';
            // const runningOrder = ORDER.runningOrder;
            try {
                // what to do if order not found
                // const ordername = runningOrder.length > 0 ? runningOrder[0][orderdetailsTags.ORDERNAME_TAG] : '';
                /*
                    query = `query=lineid==1%26%26ordername=="order-1"%26%26mainid=="Mainid-1"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
                */
                let query = `query=${[checkoutTags.LINEID_TAG]}==${lineid}`;
                // query += `%26%26${[checkoutTags.ORDERNAME_TAG]}=="${ordername}"`;
                query += `%26%26${[checkoutTags.MAINID_TAG]}=="${data[staticTags.MAINID_TAG]}"`;
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        let result = response.data.results;
                        data[checkoutTags.MODESTATUS_TAG] = result[0][checkoutTags.MODESTATUS_TAG];
                        const mainidOrder = ORDER.runningOrder.filter((item) => {
                            const { orderdata } = item;
                            return response.data.results[0][orderdetailsTags.ORDERNAME_TAG] === orderdata[orderdetailsTags.ORDERNAME_TAG];
                        });
                        const runningOrder = mainidOrder[0];
                        // check the previous substation processed properly or not based on roadmap
                        // BUG RA-I468
                        let isCorrectSubstation = this.checkIsCorrectSubstation(result[0], runningOrder);
                        if (isCorrectSubstation) {
                            // check components quality status
                            this.checkComponentQualityStatus(data, result, '', runningOrder);
                        } else {
                            log.error(`Wrong Target Substation`);
                            this.writeRecordInSWX(data, runningOrder, 'WRONGTARGETSUBSTATION');
                        }

                    } else {
                        if (substation[substationTags.INITIALSUBSTATION_TAG]) {
                            let modifiedData = { ...{}, ...data };
                            modifiedData[checkoutTags.MODESTATUS_TAG] = defaults.normalmodestatus;
                            // check components quality status
                            let result = [];
                            this.checkComponentQualityStatus(modifiedData, result, 'initialsubstation', ORDER.runningOrder[0]);
                        } else {
                            log.error(`${MESSAGESCODE.XXX05002}`);
                            this.writeMessageToKafka(data, "XXX05002")
                            this.writeRecordInSWX(data, ORDER.runningOrder[0], 'ERROR');
                        }
                    }
                } else {
                    log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`);
                    utility.checkSessionExpired(response.data);
                    this.writeRecordInSWX(data, ORDER.runningOrder[0], 'ERROR');
                }
            } catch (ex) {
                log.error(`Exception to fetch data for element : ${elementName}`);
                const messageObject = ex.response ? ex.response.data : ex
                log.error(messageObject);
                this.writeRecordInSWX(data, ORDER.runningOrder[0], 'ERROR');
            }
        },

        async checkComponentQualityStatus(data, partstatusRecord, substationtype, runningOrder) {
            if (runningOrder.orderdata && runningOrder.orderdata[orderdetailsTags.BOMID_TAG]) {
                this.checkComponentIdNotForCurrentStation(data, partstatusRecord, substationtype, runningOrder);
            } else {
                // prepare the processparameter and component payload
                const substationResult = data[staticTags.SUBSTATIONRESULT_TAG];
                const processParameterArray = processParameter.processParametersPayload(data);
                if (processParameterArray.length > 0) {
                    await this.createElementMultipleRecords('process_' + substationid, processParameterArray, 'processparameter')
                }
                const componentParameterArray = componentParameter.componentPayload(data, runningOrder, substationResult);
                // BUG RA-I422
                if (componentParameterArray.componentArray.length > 0 && componentParameterArray.isAllComponentIdPresent) {
                    await this.createElementMultipleRecords(elements.component, componentParameterArray.componentArray, 'component');
                } else if (!componentParameterArray.isAllComponentIdPresent) {
                    log.error(`All component not written on PLC`);
                    CheckOutResult = CheckOutValues.ERROR;
                    this.writeRecordInSWX(data, runningOrder.orderdata);
                    return;
                }
                this.writeProductionDataInMES(data, partstatusRecord, substationtype, componentParameterArray, runningOrder)

                // process writeUpdate or update partstatus
                // const runningOrder = ORDER.runningOrder;
                // if (substationtype === 'initialsubstation') {
                //     this.writeUpdatePartStatus(data, partstatusRecord, runningOrder);
                // } else {
                //     this.updatePartStatus(data, partstatusRecord, runningOrder);
                // }
            }
        },
        /**
         * Check the component parametername is not present in existing substation for avoiding API call
         */
        async checkComponentIdNotForCurrentStation(data, partstatusRecord, substationtype, runningOrder) {
            const bomComponent = runningOrder.bomDetailsComponentForS;
            const bomComponentQualityStatus = runningOrder.bomDetailsQualityStatusForS;
            const bomComponentArray = [];
            const substationResult = data[staticTags.SUBSTATIONRESULT_TAG];
            // if substationresult is testfailed or not and based on it check component quality status
            if (substationResult != CheckOutValues.TESTFAILED) {
                for (var i = 0; i < bomComponentQualityStatus.length; i++) {
                    var isPresent = false;
                    for (var j = 0; j < bomComponent.length; j++) {
                        if (bomComponent[j][bomDetailsTags.SAVEDATA_TAG] && bomComponent[j][bomDetailsTags.PARAMETERNAME_TAG] === bomComponentQualityStatus[i][bomDetailsTags.PARAMETERNAME_TAG]) {
                            isPresent = true;
                        }
                    }
                    // check the quality status is true and parameter category is component or not
                    if (!isPresent && bomComponentQualityStatus[i][bomDetailsTags.QUALITYSTATUS_TAG] && bomComponentQualityStatus[i][bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.componentID) {
                        bomComponentArray.push(bomComponentQualityStatus[i]);
                    }
                }
                if (bomComponentArray.length > 0) {
                    this.getMultipleRecords(data, partstatusRecord, substationtype, substationResult, bomComponentArray);
                } else {
                    log.error(`no bomComponent found for quality status in this substation`);
                    // prepare the processparameter and component payload
                    const processParameterArray = processParameter.processParametersPayload(data);
                    if (processParameterArray.length > 0) {
                        await this.createElementMultipleRecords('process_' + substationid, processParameterArray, 'processparameter')
                    }
                    const componentParameterArray = componentParameter.componentPayload(data, runningOrder, substationResult);
                    // BUG RA-I422
                    if (componentParameterArray.componentArray.length > 0 && componentParameterArray.isAllComponentIdPresent) {
                        await this.createElementMultipleRecords(elements.component, componentParameterArray.componentArray, 'component');
                    } else if (!componentParameterArray.isAllComponentIdPresent) {
                        log.error(`All component not written on PLC`);
                        CheckOutResult = CheckOutValues.ERROR;
                        this.writeRecordInSWX(data, runningOrder);
                        return;
                    }
                    this.writeProductionDataInMES(data, partstatusRecord, substationtype, componentParameterArray, runningOrder)

                    // process writeUpdate or update partstatus
                    // const runningOrder = ORDER.runningOrder;
                    // if (substationtype === 'initialsubstation') {
                    //     this.writeUpdatePartStatus(data, partstatusRecord, runningOrder);
                    // } else {
                    //     this.updatePartStatus(data, partstatusRecord, runningOrder);
                    // }
                }
            } else {
                log.error(`Test Failed response received from PLC for substationResult. Ignore the update Quality status condition`);
                // prepare the processparameter and component payload
                const processParameterArray = processParameter.processParametersPayload(data);
                if (processParameterArray.length > 0) {
                    await this.createElementMultipleRecords('process_' + substationid, processParameterArray, 'processparameter')
                }
                const componentParameterArray = componentParameter.componentPayload(data, runningOrder, substationResult);
                // BUG RA-I422
                if (componentParameterArray.componentArray.length > 0 && componentParameterArray.isAllComponentIdPresent) {
                    await this.createElementMultipleRecords(elements.component, componentParameterArray.componentArray, 'component');
                } else if (!componentParameterArray.isAllComponentIdPresent) {
                    log.error(`All component not written on PLC`);
                    CheckOutResult = CheckOutValues.ERROR;
                    this.writeRecordInSWX(data, runningOrder);
                    return;
                }
                this.writeProductionDataInMES(data, partstatusRecord, substationtype, componentParameterArray, runningOrder)

                // process writeUpdate or update partstatus
                // const runningOrder = ORDER.runningOrder;
                // if (substationtype === 'initialsubstation') {
                //     this.writeUpdatePartStatus(data, partstatusRecord, runningOrder);
                // } else {
                //     this.updatePartStatus(data, partstatusRecord, runningOrder);
                // }
            }
        },
        /**
         * Get latest record of each component from database for checking status and result
         * @param {*} plcdata
         */
        async getMultipleRecords(plcdata, partstatusRecord, substationtype, substationResult, bomComponentArray) {
            const elementName = elements.component;
            const payload = [];
            for (var i = 0; i < bomComponentArray.length; i++) {
                let query = `${checkoutTags.MAINID_TAG}=="${plcdata[checkoutTags.MAINID_TAG]}"`;
                query += `&&${componentTags.COMPONENTNAME_TAG}=="${bomComponentArray[i][bomDetailsTags.PARAMETERNAME_TAG]}"`;
                const obj = {
                    "elementName": elementName,
                    "pageNumber": 1,
                    "pageSize": 1,
                    "query": query,
                    "sortQuery": `createdTimestamp==-1`
                }
                payload.push(obj);
            }
            try {
                const response = await elementService.getMultipleElementsQueryRecords(payload);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.length > 0) {
                        this.CheckComponent(plcdata, partstatusRecord, substationtype, substationResult, bomComponentArray, response.data);
                    }
                } else {
                    log.error(`Error in getMultipleComponent `);
                }
            } catch (ex) {
                log.error(`Exception in getMultipleComponent ${ex}`);
            }

        },
        /**
         * Get all component status and decide the componenet checkresult
         * @param {*} data
         * @param {*} componentData
         */
        async CheckComponent(data, partstatusRecord, substationtype, substationResult, bomComponentArray, response, runningOrder) {
            // check the component is already processed and it's bound status, rework status, quality status
            const finalArrayOfQualityStatus = [];
            for (var i = 0; i < bomComponentArray.length; i++) {
                let query = `${checkoutTags.MAINID_TAG}=="${data[checkoutTags.MAINID_TAG]}"`;
                query += `&&${componentTags.COMPONENTNAME_TAG}=="${bomComponentArray[i][bomDetailsTags.PARAMETERNAME_TAG]}"`;
                for (var j = 0; j < response.length; j++) {
                    const parseRequest = response[j].request;
                    if (parseRequest.query === query) {
                        const res = this.componentQualityStatus(bomComponentArray[i], substationResult, response[j].results)
                        if (res.id) {
                            finalArrayOfQualityStatus.push(res);
                        }
                    }
                }
            }
            if (finalArrayOfQualityStatus.length > 0) {
                // update multiple records by id using updatemultiple API
                await this.updateQaulityStatusInSWX(finalArrayOfQualityStatus);
            } else {
                log.error(`No record found for update quality status in component table`)
            }
            // prepare the processparameter and component payload
            const processParameterArray = processParameter.processParametersPayload(data);
            if (processParameterArray.length > 0) {
                await this.createElementMultipleRecords('process_' + substationid, processParameterArray, 'processparameter')
            }
            const componentParameterArray = componentParameter.componentPayload(data, runningOrder, substationResult);
            // BUG RA-I422
            if (componentParameterArray.componentArray.length > 0 && componentParameterArray.isAllComponentIdPresent) {
                await this.createElementMultipleRecords(elements.component, componentParameterArray.componentArray, 'component');
            } else if (!componentParameterArray.isAllComponentIdPresent) {
                log.error(`All component not written on PLC`);
                CheckOutResult = CheckOutValues.ERROR;
                this.writeRecordInSWX(data, runningOrder);
                return;
            }
            // process writeUpdate or update partstatus
            this.writeProductionDataInMES(data, partstatusRecord, substationtype, componentParameterArray, runningOrder)

            // const runningOrder = ORDER.runningOrder;
            // if (substationtype === 'initialsubstation') {
            //     this.writeUpdatePartStatus(data, partstatusRecord, runningOrder);
            // } else {
            //     this.updatePartStatus(data, partstatusRecord, runningOrder);
            // }
        },
        /**
         * This method call the methods of the quanlity status of component
         * @param {Object} bomrecord
         * @param {Object} result
         */
        componentQualityStatus(bomdetails, substationResult, record) {
            if (record.length > 0) {
                return {
                    id: record[0]._id,
                    [componentTags.QUALITYSTATUS_TAG]: substationResult
                }
            } else {
                log.error(`no record found in component for componentid ${bomdetails[bomDetailsTags.PARAMETERNAME_TAG]}`);
                CheckOutResult = CheckOutValues.ERROR;
                return {};
            }
        },
        /**
         * Update the bound status of component id
         * @param {*} record
         */
        async updateQaulityStatusInSWX(payload) {
            const elementName = elements.component;
            try {
                let response = await elementService.updateElementMultipleRecords(elementName, payload);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Componented Quality Status successfully`);
                } else {
                    log.error(`Error in  Quality Status of components`);
                }
            } catch (ex) {
                log.error(`Exception in  Quality Status of components ${ex}`);
            }
        },
        /**
        * Update the Quality status when overallresult is NG
        * @param {*} record
        */
        async updateQaulityStatusInSWXByQuery(plcdata) {
            const elementName = elements.component;
            try {
                // check the overallresult if it is NG then update all component mount with mainid
                // query=mainid=="1234"&&qualitystatus!=0
                let query = `query=${checkoutTags.MAINID_TAG}=="${plcdata[staticTags.MAINID_TAG]}"%26%26${componentTags.QUALITYSTATUS_TAG}!=${ComponentValues.DEFAULT}`;
                let payload = {
                    [componentTags.QUALITYSTATUS_TAG]: plcdata[staticTags.SUBSTATIONRESULT_TAG]
                };
                let response = await elementService.updateElementRecordsByQuery(elementName, payload, query);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Overall Result NG Update Component Quality Status successfully`);
                } else {
                    log.error(`Error in Overall Result NG update Quality Status of components`);
                }
            } catch (ex) {
                log.error(`Exception in Overall Result NG update Quality Status of components ${ex}`);
            }
        },
        /**
         * This method check the part is rework nor not based on Checkout NG Code value
         * @param {Object} plcdata
         * @param {Object} laststationRecord
         * @param {Object} runningOrder
         */
        CheckoutNGHandle(plcdata, runningOrder) {
            // If checkoutngcode value is not 0 then we write Rework entry in Rework Table
            if (plcdata[staticTags.SUBSTATIONRESULT_TAG] == CheckOutValues.NG) {
                // BUG FIX RA-I486
                this.updateQaulityStatusInSWXByQuery(plcdata);
                this.writeReworkRecordInSWX(plcdata, runningOrder);
            }
        },
        /**
         * This method check recipe written on PLC. If not then retry for configurable number of count
         * @param {Object} data
         */
        CheckOutFeedbacktoPLC(data) {
            let plcdata = data;
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
                    log.error(`${MESSAGESCODE.XXX05010}`);
                    this.writeMessageToKafka(plcdata, "XXX05010")
                    this.writeTargetSubStatationFlag = false;
                } else if (isValid) {
                    // if all ok then stop validation
                    this.writeTargetSubStatationFlag = false;
                    this.setCheckOutResult();
                }
            }
            // check CheckOutResult
            if (writeCheckOutResultFlag) {
                // if CheckOutResult value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = CheckOutResult === data[staticTags.CHECKOUTRESULT_TAG] ? true : false;
                if (!isValid && checkoutResultCount < feebackWriteCount) {
                    clearTimeout(writeCheckOutResultTimer);
                    this.resetCheckOutResult();
                    // plc polling is reduced to 50 ms
                    writeCheckOutResultTimer = setTimeout(() => {
                        this.setCheckOutResult();
                    }, retryToPLCTimer);
                    checkoutResultCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);

                } else if (!isValid && checkoutResultCount === feebackWriteCount) {
                    // after 3 times retry error in writing to PLC
                    log.error(`${MESSAGESCODE.XXX05011}`);
                    this.writeMessageToKafka(plcdata, "XXX05011")
                    this.resetCheckOutResult();
                    // no need to write completed because default value is 0
                    // CheckOutCompleted = 0;
                    // this.setCheckOutCompleted();

                } else if (isValid) {
                    // if all ok then stop validation
                    this.resetCheckOutResult();
                    this.setCheckOutCompleted();
                }
            }
            // check CheckOutCompleted
            if (writeCheckOutCompletedFlag) {
                // if CheckOutCompleted value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = CheckOutCompleted === data[staticTags.CHECKOUTCOMPLETED_TAG] ? true : false;
                if (!isValid && checkoutCompleteCount < feebackWriteCount) {
                    clearTimeout(writeCheckOutCompletedTimer);
                    this.resetCheckOutCompleted()
                    // plc polling is reduced to 50 ms
                    writeCheckOutCompletedTimer = setTimeout(() => {
                        this.setCheckOutCompleted()
                    }, retryToPLCTimer);
                    checkoutCompleteCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKOUTCOMPLETED_TAG, CheckOutCompleted);

                } else if (!isValid && checkoutCompleteCount === feebackWriteCount) {
                    log.error(`${MESSAGESCODE.XXX05012}`);
                    this.writeMessageToKafka(plcdata, "XXX05012")
                    checkoutCompleteCount++;
                    // after 3 times retry error in writing to PLC
                    this.resetCheckOutCompleted()

                } else if (isValid) {
                    // if all ok then stop validation
                    this.resetCheckOutCompleted()
                }
            }
        },
        /**
         * Reset the values i.e. who write who reset
         * @param {Object} data
         */
        resetAck(data) {
            let plcdata = data;
            // reset CheckOutResult, CheckOutCompleted
            const isCheckOutCompleted = 0 === data[staticTags.CHECKOUTCOMPLETED_TAG] ? true : false;
            // wait for 2 seconds and then reset values
            if (!this.reset && resetCheckOutCompletedFlag) {
                this.reset = true;
                setTimeout(() => {
                    this.write = true;
                }, resetValueDealyTime * 1000);
            } else if (this.write && resetCheckOutCompletedFlag) {
                if (resetCheckOutCompletedFlag && !isCheckOutCompleted && resetCheckOutCompletedCount < feebackWriteCount) {
                    clearTimeout(this.resetCheckOutCompletedTimer);
                    resetCheckOutCompletedFlag = false;
                    // plc polling is reduced to 50 ms
                    this.resetCheckOutCompletedTimer = setTimeout(() => {
                        resetCheckOutCompletedFlag = true;
                    }, retryToPLCTimer);

                    resetCheckOutCompletedCount++;
                    this.targetSubStation = 0;
                    this.postDatatoSocketPLCWrite(staticTags.TARGETSUBSTATION_TAG, this.targetSubStation);
                    CheckOutResult = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);
                    CheckOutCompleted = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKOUTCOMPLETED_TAG, CheckOutCompleted);

                } else if (!isCheckOutCompleted && resetCheckOutCompletedCount === feebackWriteCount) {
                    // after 3 times retry error in write reset values on PLC
                    log.error(`${MESSAGESCODE.XXX05013}`);
                    this.writeMessageToKafka(plcdata, "XXX05013")
                    resetCheckOutCompletedFlag = false;

                } else if (isCheckOutCompleted) {
                    // reset values written successfully on PLC
                    resetCheckOutCompletedFlag = false;
                }
            }
        },

        /**
         *
         * @param {*} runningRoadMap
         * @param {*} partstatusRecord
         */
        async getTargetSubStationForSubstation(partstatusRecord, runningOrder) {
            const { orderdata } = runningOrder;
            let targetSubstationArray = [];
            let updatesubstationFlag = false;
            try {
                let roadmapid = partstatusRecord.length > 0 ? partstatusRecord[0][checkoutTags.ROADMAPID_TAG] : orderdata[checkoutTags.ROADMAPID_TAG];
                let roadMapDetails = await ORDER.getTargetSubStationForSubstation(roadmapid);
                if (roadMapDetails.length > 0) {
                    if (partstatusRecord.length > 0) {
                        let substationID = partstatusRecord[0][checkoutTags.SUBSTATIONID_TAG];
                        if (substationID) {
                            log.error(`record present in partstatus with substation id and part is rework or fresh for substationid ${substationID}`);
                            let matchingSubstation = roadMapDetails.filter(roadmap => roadmap[roadmapTags.PRESUBSTATIONID_TAG] == substationID);
                            if (matchingSubstation.length > 0) {
                                let isCorrectSubstation = matchingSubstation.filter(record => record[roadmapTags.SUBSTATIONID_TAG] === substationid)
                                if (isCorrectSubstation.length > 0) {
                                    let followingSubstation = roadMapDetails.filter(roadmap => roadmap[roadmapTags.PRESUBSTATIONID_TAG] == substationid);
                                    if (followingSubstation.length > 0) {
                                        targetSubstationArray = followingSubstation;
                                        updatesubstationFlag = true;
                                    }
                                } else {
                                    targetSubstationArray = matchingSubstation;
                                }
                            } else {
                                targetSubstationArray = [];
                            }
                        } else {
                            log.error(`record present in partstatus but no substationid rework part`);
                            if (substationid === roadMapDetails[0][roadmapTags.SUBSTATIONID_TAG]) {
                                // check following substation of currentsubstation
                                let followingSubstation = roadMapDetails.filter(roadmap => roadmap[roadmapTags.PRESUBSTATIONID_TAG] == substationid);
                                if (followingSubstation.length > 0) {
                                    targetSubstationArray = followingSubstation;
                                    updatesubstationFlag = true;
                                }
                            } else {
                                // write target substation as 1st substationid in roadmap
                                targetSubstationArray.push(roadMapDetails[0]);
                            }
                        }
                    } else {
                        log.error(`record not present in partstatus consider it as fresh or new record in partstatus`)
                        let roadmapid = orderdata[checkoutTags.ROADMAPID_TAG];
                        targetSubstationArray = await ORDER.getTargetSubStationForSubstation(roadmapid, substationid);

                    }
                } else {
                    log.error(`No roadmap record found in roadmap details for roadmapid : ${roadmapid}`)
                }
            } catch (ex) {
                log.error(`Exception in getting roadmap details for targetsubstation ${ex}`);
            }
            return { updatesubstationFlag: updatesubstationFlag, targetSubstationArray: targetSubstationArray };
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
         * This method check to write targetSubstation or not based on CheckOutResult value
         */
        writeTargetStation(plcdata, substationID) {
            if (substationID) {
                log.info(`Target substation is ${substationID}`);
                this.writeTargetSubStatationFlag = true;
                this.targetSubStation = +substationID.split('-')[1];
                this.postDatatoSocketPLCWrite(staticTags.TARGETSUBSTATION_TAG, this.targetSubStation);
            } else {
                log.error(`${MESSAGESCODE.XXX05004}`);
                this.writeMessageToKafka(plcdata, "XXX05004")
            }
        },
        /**
         * This method write update the partstatus.
         * If no record found for ordername and mainid then create new record otherwise updated
         * @param {*} plcdata
         */
        async updatePartStatus(data, partstatusRecord, runningOrder) {
            let plcdata = utility.cloneDeep(data);
            plcdata[checkoutTags.STATUS_TAG] = plcdata[staticTags.CHECKOUTNGCODE_TAG];
            // BUG RA-I580
            let proccessData = processParameter.processParametersPayload(data, substationid);
            processParameter.WriteParameterInTracabilityElement(proccessData);
            let payload = {};
            payload[checkoutTags.STATUS_TAG] = plcdata[staticTags.CHECKOUTNGCODE_TAG];
            if (substation[substationTags.FINALSUBSTATION_TAG]) {
                if (plcdata[staticTags.SUBSTATIONRESULT_TAG] == CheckOutValues.OK) {
                    payload[checkoutTags.OVERALLRESULT_TAG] = CheckOutValues.COMPLETED;
                } else {
                    payload[checkoutTags.OVERALLRESULT_TAG] = plcdata[staticTags.SUBSTATIONRESULT_TAG];
                }
                // TODO confirm with Lukas for this check
                payload[checkoutTags.SUBLINEID_TAG] = sublineid;
                payload[checkoutTags.SUBLINEID_TAG] = sublineid;
                payload[checkoutTags.SUBSTATIONID_TAG] = substationid;
                payload[checkoutTags.SUBSTATIONNAME_TAG] = substationname;
            } else {
                payload[checkoutTags.OVERALLRESULT_TAG] = plcdata[staticTags.SUBSTATIONRESULT_TAG]
            }
            let targetSubstationResult = await this.getTargetSubStationForSubstation(partstatusRecord, runningOrder);
            if (targetSubstationResult.updatesubstationFlag) {
                payload[checkoutTags.SUBLINEID_TAG] = sublineid;
                payload[checkoutTags.SUBSTATIONID_TAG] = substationid;
                payload[checkoutTags.SUBSTATIONNAME_TAG] = substationname;
                let proccessData = processParameter.processParametersPayload(plcdata, substationid);
                processParameter.WriteParameterInTracabilityElement(proccessData);
            }
            log.error(`Update PartStatus Payload ${JSON.stringify(payload)}`);
            const elementName = elements.partstatus || 'partstatus';
            try {
                // added running order information in plcdata in above step
                // const ordername = runningOrder[0][orderdetailsTags.ORDERNAME_TAG];
                /*
                    query = `query=ordername=="order-1"%26%26mainid=="Mainid1"`;
                */
                // let query = `query=${[checkoutTags.ORDERNAME_TAG]}=="${ordername}"`;
                // query += `%26%26${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.MAINID_TAG]}"`;
                const response = await elementService.updateElementRecordById(elementName, payload, partstatusRecord[0]._id);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Record update successfully in ShopWorx ${JSON.stringify(response.data)}`);
                    const targetSubstation = this.getTargetSubStationID(targetSubstationResult.targetSubstationArray);
                    this.writeTargetStation(plcdata, targetSubstation);
                    // write record
                    // TODO if required to write targetsubstation in checkout element
                    if (targetSubstation) {
                        plcdata[staticTags.TARGETSUBSTATION_TAG] = targetSubstation;
                    }
                    this.writeRecordInSWX(plcdata, runningOrder);
                } else {
                    // check authentication
                    utility.checkSessionExpired(response.data);
                    log.error(`${MESSAGESCODE.XXX05005} ${JSON.stringify(response.data)}`);
                    this.writeMessageToKafka(plcdata, "XXX05005")
                    CheckOutResult = CheckOutValues.SAVEDATAERROR;
                    this.writeRecordInSWX(plcdata, runningOrder);
                }
            } catch (ex) {
                log.error(`${MESSAGESCODE.XXX05006} ${ex}`);
                this.writeMessageToKafka(plcdata, "XXX05006")
                CheckOutResult = CheckOutValues.SAVEDATAERROR;
                this.writeRecordInSWX(plcdata, runningOrder);
            }
        },
        /**
         * This method write update the partstatus.
         * If no record found for ordername and mainid then create new record otherwise updated
         * @param {*} plcdata
         */
        async writeUpdatePartStatus(data, partstatusRecord, runningOrder) {
            let plcdata = utility.cloneDeep(data);
            // BUG RA-I580
            let proccessData = processParameter.processParametersPayload(data, substationid);
            processParameter.WriteParameterInTracabilityElement(proccessData);
            if (runningOrder.orderdata) {
                plcdata = { ...runningOrder.orderdata, ...plcdata };
            }
            plcdata[checkoutTags.LINEID_TAG] = lineid;
            plcdata[checkoutTags.SUBLINEID_TAG] = sublineid;
            plcdata[checkoutTags.SUBSTATIONID_TAG] = substationid;
            plcdata[checkoutTags.SUBSTATIONNAME_TAG] = substationname;
            plcdata[checkoutTags.STATUS_TAG] = plcdata[staticTags.CHECKOUTNGCODE_TAG];
            let roadmapid = runningOrder.orderdata[roadmapTags.ROADMAPID_TAG];
            let targetSubstationResult = await this.getTargetSubStationForSubstation(partstatusRecord, runningOrder);
            if (targetSubstationResult.updatesubstationFlag) {
                plcdata[checkoutTags.SUBSTATIONID_TAG] = substationid;
                plcdata[checkoutTags.SUBSTATIONNAME_TAG] = substationname;
            }
            let payload = utility.assignDataToSchema(plcdata, partstatusSchema)
            plcdata[checkoutTags.ROADMAPID_TAG] = roadmapid;
            payload.assetid = substation.assetid;
            if (substation[substationTags.FINALSUBSTATION_TAG]) {
                if (plcdata[staticTags.SUBSTATIONRESULT_TAG] == CheckOutValues.OK) {
                    payload[checkoutTags.OVERALLRESULT_TAG] = CheckOutValues.COMPLETED;
                } else {
                    payload[checkoutTags.OVERALLRESULT_TAG] = plcdata[staticTags.SUBSTATIONRESULT_TAG];
                }
            } else {
                payload[checkoutTags.OVERALLRESULT_TAG] = plcdata[staticTags.SUBSTATIONRESULT_TAG]
            }
            log.error(`Partstatus Schema length ${partstatusSchema.length}`);
            log.error(`Init PartStatus Payload ${JSON.stringify(payload)}`);
            const elementName = elements.partstatus || 'partstatus';
            try {
                // added running order information in plcdata in above step
                const ordername = plcdata[orderdetailsTags.ORDERNAME_TAG];
                /*
                    query = `query=ordername=="order-1"%26%26mainid=="Mainid-1"`
                */
                let query = `query=${[checkoutTags.ORDERNAME_TAG]}=="${ordername}"`;
                query += `%26%26${[checkoutTags.MAINID_TAG]}=="${plcdata[staticTags.MAINID_TAG]}"`;
                const response = await elementService.upsertElementRecordsByQuery(elementName, payload, query);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Record write/update successfully in ShopWorx ${JSON.stringify(response.data)}`);
                    // pass parameter as null because we don't have feedback value here.
                    // pass parameter as newrecord for executing ordercount condition
                    const targetSubstation = this.getTargetSubStationID(targetSubstationResult.targetSubstationArray);
                    this.writeTargetStation(plcdata, targetSubstation);
                    // TODO if required to write targetsubstation in checkout element
                    if (targetSubstation) {
                        plcdata[staticTags.TARGETSUBSTATION_TAG] = targetSubstation;
                    }
                    this.writeRecordInSWX(data, runningOrder, null, 'newrecord')
                } else {
                    // check authentication
                    utility.checkSessionExpired(response.data);
                    log.error(`${MESSAGESCODE.XXX05007}`);
                    this.writeMessageToKafka(plcdata, "XXX05007")
                    CheckOutResult = CheckOutValues.SAVEDATAERROR;
                    this.setCheckOutResult();
                    this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);
                    CheckOutCompleted = CheckOutValues.SUCCESSFUL;
                }
            } catch (ex) {
                log.error(`${MESSAGESCODE.XXX05006}`);
                this.writeMessageToKafka(plcdata, "XXX05006")
                CheckOutResult = CheckOutValues.SAVEDATAERROR;
                this.setCheckOutResult();
                this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);
                CheckOutCompleted = CheckOutValues.SUCCESSFUL;
            }
        },
        /**
         * This method write the checkout result in ShopWorx database
         * @param {Object} plcdata
         * @param {Array} runningOrder
         */
        async writeRecordInSWX(data, runningOrder, isfeedback, newrecord) {
            let plcdata = utility.cloneDeep(data)
            if (runningOrder.orderdata) {
                plcdata = { ...runningOrder.orderdata, ...plcdata };
            }
            plcdata[checkoutTags.LINEID_TAG] = lineid;
            plcdata[checkoutTags.SUBLINEID_TAG] = sublineid;
            plcdata[checkoutTags.SUBSTATIONID_TAG] = substationid;
            plcdata[checkoutTags.SUBSTATIONNAME_TAG] = substationname;
            plcdata[checkoutTags.STATUS_TAG] = plcdata[staticTags.CHECKOUTNGCODE_TAG];
            // if plcdata does not have the modestatus value then assign it as normal and write it in checkout
            // we update plcdata with modestatus when partstatus response received
            if (!plcdata[checkoutTags.MODESTATUS_TAG]) {
                plcdata[checkoutTags.MODESTATUS_TAG] = defaults.normalmodestatus;
            }
            // this check for process or component write status in ShopWorx is error
            if (CheckOutResult === CheckOutValues.ERROR) {
                CheckOutResult = CheckOutValues.ERROR;
            } else if (isfeedback === 'MISSINGDATA') {
                CheckOutResult = CheckOutValues.MISSINGDATA;
            } else if (isfeedback === 'ERROR') {
                CheckOutResult = CheckOutValues.ERROR;
            } else if (isfeedback === 'WRONGTARGETSUBSTATION') {
                CheckOutResult = CheckOutValues.WRONGTARGETSUBSTATION;
            } else {
                CheckOutResult = CheckOutValues.OK;
            }
            plcdata[checkoutTags.CHECKOUTRESULT_TAG] = CheckOutResult;
            let payload = utility.assignDataToSchema(plcdata, checkoutSchema)
            payload.assetid = substation.assetid;
            log.trace(`Checkout Payload ${JSON.stringify(payload)}`);
            const elementName = elements.checkout || 'checkout'
            try {
                const response = await elementService.createElementRecord(elementName, payload)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Record saved successfully in ShopWorx for checkout ${JSON.stringify(response.data)}`);
                    // check Part is NG or not
                    this.CheckoutNGHandle(data, runningOrder);
                    // write / increment order count
                    if (newrecord == 'newrecord' && substation[substationTags.INITIALSUBSTATION_TAG] && substation[substationTags.ISMAINLINE_TAG]) {
                        if (!runningOrder.ordercount) {
                            runningOrder.ordercount = 1;
                        } else {
                            runningOrder.ordercount += 1;
                        }
                        this.writeUpdateOrderCount(plcdata, runningOrder.ordercount, runningOrder);
                    }
                    if (mainidConfig.virtualmainid && CheckOutResult == CheckOutValues.OK) {
                        VIRTUALMAINID.mainid = '';
                        log.error('Reset Virtual Mainid');
                    }
                    if (mainidConfig.unbindstation && unbindstation.mainidbindcarrierid && CheckOutResult == CheckOutValues.OK) {
                        const mainid = plcdata[staticTags.MAINID_TAG];
                        const carrierid = plcdata[staticTags.CARRIERID_TAG];
                        const result = await new Promise((resolve) => {
                            VIRTUALMAINID.unbindMainIdWithCarrierId(mainid, carrierid, resolve)
                        })
                        if (result.state) {
                            log.error(`mainid: ${mainid} unbind with carrierid: ${carrierid}`)
                        } else {
                            log.error(result.msg);
                            log.error(`Write Feedback to PLC as SAVEDATAERROR`);
                            // write to PLC
                            CheckOutResult = CheckOutValues.SAVEDATAERROR;
                            this.setCheckOutResult();
                            this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);
                            CheckOutCompleted = CheckOutValues.SUCCESSFUL;
                            return;
                        }
                    }
                    // write to PLC
                    log.error(`Write Feedback to PLC as ${CheckOutResult}`);
                    this.setCheckOutResult();
                    this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);
                    CheckOutCompleted = CheckOutValues.SUCCESSFUL;
                } else {
                    log.error(`${MESSAGESCODE.XXX05008} - ${JSON.stringify(response.data)}`);
                    this.writeMessageToKafka(plcdata, "XXX05008")
                    utility.checkSessionExpired(response.data);
                    log.error(`Write Feedback to PLC as SAVEDATAERROR`);
                    // write to PLC
                    CheckOutResult = CheckOutValues.SAVEDATAERROR;
                    this.setCheckOutResult();
                    this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);
                    CheckOutCompleted = CheckOutValues.SUCCESSFUL;
                }
            } catch (ex) {
                log.error(`${MESSAGESCODE.XXX05009} - ${ex}`);
                this.writeMessageToKafka(plcdata, "XXX05009")
                // write to PLC
                CheckOutResult = CheckOutValues.SAVEDATAERROR;
                this.setCheckOutResult();
                this.postDatatoSocketPLCWrite(staticTags.CHECKOUTRESULT_TAG, CheckOutResult);
                CheckOutCompleted = CheckOutValues.SUCCESSFUL;
            }

        },

        /**
         * This method write the checkout result in ShopWorx database
         * @param {Object} plcdata
         * @param {Array} runningOrder
         */
        async writeReworkRecordInSWX(plcdata, runningOrder) {
            plcdata = utility.cloneDeep(plcdata)
            if (runningOrder.orderdata) {
                plcdata = { ...runningOrder.orderdata, ...plcdata };
            }
            plcdata[checkoutTags.LINEID_TAG] = lineid;
            plcdata[checkoutTags.SUBLINEID_TAG] = sublineid;
            plcdata[checkoutTags.SUBSTATIONID_TAG] = substationid;
            plcdata[checkoutTags.SUBSTATIONNAME_TAG] = substationname;
            plcdata[checkoutTags.STATUS_TAG] = plcdata[staticTags.CHECKOUTNGCODE_TAG];
            let payload = utility.assignDataToSchema(plcdata, reworkSchema)
            payload.assetid = substation.assetid;
            log.trace(`Rework Payload ${JSON.stringify(payload)}`);
            const elementName = elements.rework || 'rework'
            try {
                const response = await elementService.createElementRecord(elementName, payload)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Record saved successfully in ShopWorx for rework ${JSON.stringify(response.data)}`);
                } else {
                    log.error(`${MESSAGESCODE.XXX05016} ${JSON.stringify(response.data)}`);
                    this.writeMessageToKafka(plcdata, "XXX05016")
                    utility.checkSessionExpired(response.data);
                }
            } catch (ex) {
                log.error(`${MESSAGESCODE.XXX05017} ${ex}`);
                this.writeMessageToKafka(plcdata, "XXX05017")
            }

        },
        /**
         * This method createMultiple records for components
         * @param {*} payload
         */
        async createElementMultipleRecords(elementName, payload, type) {
            try {
                log.error(`Component ID Payload ${JSON.stringify(payload)}`);
                const response = await elementService.createElementMultipleRecords(elementName, payload)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Record saved successfully in ShopWorx for ${type} : ${elementName} response : ${JSON.stringify(response.data)}`);
                } else {
                    log.error(`Error in writing data in ShopWorx for ${type} : ${elementName} response : ${JSON.stringify(response.data)}`);
                    CheckOutResult = CheckOutValues.ERROR;
                }
            } catch (ex) {
                log.error(`Exception in writing records to elementName ${type} : ${elementName} Exception ${ex}`);
                CheckOutResult = CheckOutValues.ERROR;
            }
        },
        /**
         * This method write update the ordercount.
         * @param {*} plcdata
         * @param {*} ordercount
         * @param {*} runningOrder
         */
        async writeUpdateOrderCount(plcdata, ordercount, runningOrder) {
            let payload = {
                ordercount: ordercount,
                assetid: substation.assetid,
                timestamp: plcdata.timestamp
            };
            payload[orderdetailsTags.ORDERNUMBER_TAG] = runningOrder.orderdata[orderdetailsTags.ORDERNUMBER_TAG];
            payload[orderdetailsTags.LINEID_TAG] = lineid;
            log.trace(`ORDER COUNT Payload ${JSON.stringify(payload)}`);
            const elementName = elements.ordercount || 'ordercount';
            try {
                /*
                    query = `query=ordername=="order-1"`
                */
                let query = `query=${orderdetailsTags.ORDERNUMBER_TAG}=="${runningOrder.orderdata[orderdetailsTags.ORDERNUMBER_TAG]}"`;
                const response = await elementService.upsertElementRecordsByQuery(elementName, payload, query);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Record write/update ORDER COUNT successfully in ShopWorx ${JSON.stringify(response.data)}`);
                } else {
                    log.error(`${MESSAGESCODE.XXX05014} ${JSON.stringify(response.data)}`);
                    this.writeMessageToKafka(plcdata, "XXX05014")
                    utility.checkSessionExpired(response.data);
                }
            } catch (ex) {
                log.error(`${MESSAGESCODE.XXX05015} ${elementName} ${ex}`);
                this.writeMessageToKafka(plcdata, "XXX05015")
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

        async writeProductionDataInMES(data, partstatusRecord, substationtype, componentParameterArray, runningOrder) {
            try {
                const processParameterArray = processParameter.processMESParametersPayload(data);
                const head = {
                    order_id: runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG],
                    work_center: erpcode,
                    part_no_id: data[staticTags.MAINID_TAG],
                    bomlist: componentParameterArray.componentArray.filter((item) => item[componentTags.PARAMETERCATEGORY_TAG] == defaults.batchID).map((item) => item[componentTags.COMPONENTVALUE_TAG]),
                    result: (data[staticTags.SUBSTATIONRESULT_TAG] == 1 ? 1 : 0).toString(),
                    ng_code: data[staticTags.CHECKOUTNGCODE_TAG].toString(),
                };
                const body = processParameterArray.map((item) => {
                    return {
                        mch_no: '',
                        para_no: item[parameterTags.PARAMETERNAME_TAG],
                        versionno: '',
                        collect_value: '',
                        eigen_value: item[parameterTags.PARAMETERVALUE_TAG].toString(),
                    };
                });
                log.error(`head: ${JSON.stringify(head)}`);
                log.error(`body: ${JSON.stringify(body)}`);
                const response = await InterfaceService.commitProductionData({ head, body });
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data.returncode === '0') {
                        // process writeUpdate or update partstatus
                        if (substationtype === 'initialsubstation') {
                            this.writeUpdatePartStatus(data, partstatusRecord, runningOrder);
                        } else {
                            this.updatePartStatus(data, partstatusRecord, runningOrder);
                        }
                    }
                    else {
                        log.error(`Process Data Commit error`);
                        CheckOutResult = CheckOutValues.ERROR;
                        this.writeRecordInSWX(data, runningOrder);
                        return;
                    }
                } else {
                    log.error(`Process Data Commit error`);
                    CheckOutResult = CheckOutValues.ERROR;
                    this.writeRecordInSWX(data, runningOrder);
                    return;
                }
                // // process writeUpdate or update partstatus
                // if (substationtype === 'initialsubstation') {
                //     this.writeUpdatePartStatus(data, partstatusRecord, runningOrder);
                // } else {
                //     this.updatePartStatus(data, partstatusRecord, runningOrder);
                // }
            } catch (error) {
                log.error(`Exception to Write Production Data In MES !`);
                const messageObject = error.response ? ex.response.data : error
                log.error(messageObject);
                this.writeRecordInSWX(data, runningOrder, 'ERROR');
            }
        },

        resetCheckOutCompleted() {
            writeCheckOutCompletedFlag = false;
        },
        setCheckOutCompleted() {
            writeCheckOutCompletedFlag = true;
        },
        resetCheckOutResult() {
            writeCheckOutResultFlag = false;
        },
        setCheckOutResult() {
            writeCheckOutResultFlag = true;
        },
        /**
         * Reset All flag when checkout triggered
         */
        resetAllFlag() {
            writeCheckOutCompletedFlag = false;
            writeCheckOutResultFlag = false;
            this.writeTargetSubStatationFlag = false;
        },
        /**
         * This method check the current station is correct or not based on lastStationData substationid
         * @param {Object} lastStationData
         */
        checkIsCorrectSubstation(lastStationData, runningOrder) {
            let runningRoadMap = runningOrder.runningRoadMap;
            let isProcessed = false;
            if (!substation[substationTags.INITIALSUBSTATION_TAG]) {
                for (var i = 0; i < runningRoadMap.length; i++) {
                    if (lastStationData[checkoutTags.SUBSTATIONID_TAG] === runningRoadMap[i][roadmapTags.PRESUBSTATIONID_TAG]) {
                        isProcessed = true;
                    }
                }
            } else {
                isProcessed = true;
            }
            return isProcessed;
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
