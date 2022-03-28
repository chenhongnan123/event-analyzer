'use strict'
module.exports.componentcheck = componentcheck;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const ComponentValues = require('../utils/constant').componentcheckresult;
function componentcheck(config, substation, PARAMETERS, ORDER, utility, tags, MESSAGESCODE, emitter) {
    const substationTags = tags.substationtags;
    const parameterTags = tags.parametertags;
    const staticTags = tags.statictags;
    const componentTags = tags.componenttags;
    const bomDetailsTags = tags.bomdetialsTags;
    const socketio = config.feedbacktoplcsocketio;
    const elements = config.elements;
    const defaults = config.defaults;
    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let substationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    let previousvalidatebit = 0;
    let retryServerTimer = defaults.retryServerTimer; // in seconds
    const feebackWriteCount = defaults.maxPLCRetryComponentCheckFeedbackCount;
    const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
    const resetValueDealyTime = defaults.resetValueDealyTime || 2;
    let CheckComponentResult;
    let checkComponentResultCount = 0;
    let writeCheckComponentResultFlag = false;
    let writeCheckComponentResultTimer;
    let CheckComponentCompleted;
    let checkComponentCompleteCount = 0;
    let writeCheckComponentCompletedFlag = false;
    let writeCheckComponentCompletedTimer;
    let resetCheckComponentCompletedCount = 0;
    let resetCheckComponentCompletedFlag = false;
    let componentCheckSchema = [];
    let arrayOfComponent = [];
    const log = bunyan.createLogger({ name: `ComponentCheck_${substationid}`, level: config.logger.loglevel });
    return {
        orderinfo: {},
        async getComponentCheckSchema() {
            const elementName = elements.componentcheck;
            try {
                const response = await elementService.getElement(elementName)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results) {
                        componentCheckSchema = response.data.results.tags;
                    } else {
                        log.error(`Error in getting schema for element : ${elementName}`)
                        utility.checkSessionExpired(response.data);
                        await utility.setTimer(retryServerTimer);
                        await this.getComponentCheckSchema();
                    }
                }
            } catch (ex) {
                log.error(`Exception in getting schema for element : ${elementName} ${ex}`);
                await utility.setTimer(retryServerTimer);
                await this.getComponentCheckSchema();
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
        processStationData(data1) {
            let data = utility.cloneDeep(data1);
            let removePrefix = 'q_';
            let removeParameter = 's_';
            data = utility.modifyObject(data, removePrefix, removeParameter);
            // check if feedback is written successfully on PLC or not
            if (data[staticTags.COMPONENTCHECKTRIGGER_TAG] === 1) {
                this.CheckComponentFeedbacktoPLC(data);
            }
            if (!data[staticTags.COMPONENTCHECKTRIGGER_TAG]) {
                if (previousvalidatebit) {
                    resetCheckComponentCompletedFlag = true;
                    resetCheckComponentCompletedCount = 0;
                }
                this.resetAck(data);
            }
            if (!data[staticTags.COMPONENTCHECKTRIGGER_TAG]) {
                this.resetAllFlag();
                previousvalidatebit = 0;
            }

            if (previousvalidatebit === 0 && data[staticTags.COMPONENTCHECKTRIGGER_TAG] === 1) {
                log.error(`Component Check Triggered ${JSON.stringify(data)}`);
                previousvalidatebit = 1;
                checkComponentResultCount = 0;
                checkComponentCompleteCount = 0;
                CheckComponentResult = 0;
                resetCheckComponentCompletedFlag = false;
                arrayOfComponent = [];
                this.write = false;
                this.reset = false;
                this.orderinfo = {};
                this.getComponentID(data);
            }
        },
        // use tagname as COMPONENTSTATUS_TAG for dynamic logic

        /**
         * Get the component parameters based on parametercategory as 24 configurable in config 
         */
        getComponentID(plcdata) {debugger;
            // get order
            const producttype = plcdata[staticTags.PRODUCTTYPENAME_TAG];
            const orderfornow = ORDER.runningOrder.filter((item) => item.orderdata.productname == producttype);
            if (orderfornow.length) {
                this.orderinfo = orderfornow[0];
                const bomcomponent = this.orderinfo.bomDetailsComponentForQ;
                const componentArray = [];
                for (var i = 0; i < bomcomponent.length; i++) {
                    const component = bomcomponent[i];
                    if (component[bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.componentID && component[bomDetailsTags.COMPONENTSTATUS_TAG]) {
                        componentArray.push(component);
                        const componentcheckStatusKey = component[bomDetailsTags.COMPONENTSTATUS_TAG];
                        this[componentcheckStatusKey] = 0;
                        this[componentcheckStatusKey + 'Flag'] = false;
                        this[componentcheckStatusKey + 'Count'] = 0;
                    }
                }
                this.checkComponent(plcdata, componentArray);
            } else {
                log.error(`No Running Order for this producttype: ${producttype}`);
                CheckComponentResult = ComponentValues.SAVEDATAERROR;
                this.setCheckComponentResult()
                this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTIDRESULT_TAG, CheckComponentResult);
                CheckComponentCompleted = ComponentValues.SUCCESSFUL;
            }

        },
        /**
         * 
         * @param {*} plcdata 
         * @param {*} componentArray 
         */
        checkComponent(plcdata, componentArray) {
            const finalComponentArray = [];
            for (var i = 0; i < componentArray.length; i++) {
                if (plcdata[componentArray[i][bomDetailsTags.PARAMETERNAME_TAG]]) {
                    finalComponentArray.push(componentArray[i]);
                } else {
                    log.error(`${MESSAGESCODE.XXX04000} for ${componentArray[i][bomDetailsTags.PARAMETERNAME_TAG]}`);
                    this.writeMessageToKafka(plcdata, "XXX04000")
                    // component missing in PLC data
                    this[componentArray[i][bomDetailsTags.COMPONENTSTATUS_TAG]] = ComponentValues.ERROR;
                    this.postDatatoSocketPLCWrite(componentArray[i][bomDetailsTags.COMPONENTSTATUS_TAG], ComponentValues.ERROR);
                    this.checkPriority(ComponentValues.ERROR);
                    arrayOfComponent.push({ tagdetails: componentArray[i], value: ComponentValues.ERROR });
                }
            }
            if (finalComponentArray.length > 0) {
                log.error(`Check component in component table for quality status`)
                this.getMultipleRecords(plcdata, finalComponentArray);
            } else {
                if (componentArray.length == 0) {
                    log.error(`Please check bomdetails something wrong in it`);
                    CheckComponentResult = ComponentValues.ERROR;
                }
                this.prepapreComponentCheckPayload(plcdata, arrayOfComponent);
            }
        },
        /**
         * Get latest record of each component from database for checking status and result
         * @param {*} plcdata 
         */
        async getMultipleRecords(plcdata, finalComponentArray) {
            const elementName = elements.component;
            const payload = [];
            for (var i = 0; i < finalComponentArray.length; i++) {
                let query = `${componentTags.COMPONENTNAME_TAG}=="${finalComponentArray[i][bomDetailsTags.PARAMETERNAME_TAG]}"&&${componentTags.COMPONENTVALUE_TAG}=="${plcdata[finalComponentArray[i][bomDetailsTags.PARAMETERNAME_TAG]]}"`
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
                log.trace(`Multiple Query ${JSON.stringify(payload)}`);
                const response = await elementService.getMultipleElementsQueryRecords(payload);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.length > 0) {
                        this.CheckComponent(plcdata, finalComponentArray, response.data);
                    }
                } else {
                    log.error(`Error in getMultipleComponent `);
                }
            } catch (ex) {
                log.error(`Exception in getMultipleComponent ${ex}`);
            }

        },
        /**
         * Get all component status and decide the componenetcheckresult
         * @param {*} plcdata 
         * @param {*} componentData 
         */
        CheckComponent(plcdata, finalComponentArray, response) {
            // check the component is already processed and it's bound status, rework status, quality status           
            for (var i = 0; i < finalComponentArray.length; i++) {
                const query = `${componentTags.COMPONENTNAME_TAG}=="${finalComponentArray[i][bomDetailsTags.PARAMETERNAME_TAG]}"&&${componentTags.COMPONENTVALUE_TAG}=="${plcdata[finalComponentArray[i][bomDetailsTags.PARAMETERNAME_TAG]]}"`
                for (var j = 0; j < response.length; j++) {
                    const parseRequest = response[j].request;
                    if (parseRequest.query === query) {
                        this.CheckComponentStatus(plcdata, finalComponentArray[i], response[j].results)
                    }
                }
            }
            this.prepapreComponentCheckPayload(plcdata, arrayOfComponent);
        },
        /**
         * This method prepare the payload for writing records in ComponentCheck element
         * @param {*} arrayOfComponent 
         */
        prepapreComponentCheckPayload(plcdata, arrayOfComponent) {
            const componentCheckPayload = [];
            const runningOrder = this.orderinfo;
            if (runningOrder.orderdata) {
                plcdata = { ...runningOrder.orderdata, ...plcdata };
            }
            // check component array is empty or not
            if (arrayOfComponent.length > 0) {
                for (var l = 0; l < arrayOfComponent.length; l++) {
                    const tagDetails = arrayOfComponent[l].tagdetails;
                    const obj = { ...{}, ...plcdata };
                    obj[componentTags.LINEID_TAG] = lineid;
                    obj[componentTags.SUBLINEID_TAG] = sublineid;
                    obj[componentTags.SUBSTATIONID_TAG] = substationid;
                    obj[componentTags.SUBSTATIONNAME_TAG] = substationname;
                    obj[componentTags.PARAMETERCATEGORY_TAG] = defaults.componentID;
                    obj[componentTags.COMPONENTNAME_TAG] = tagDetails[bomDetailsTags.PARAMETERNAME_TAG];
                    obj[componentTags.COMPONENTVALUE_TAG] = plcdata[tagDetails[bomDetailsTags.PARAMETERNAME_TAG]];
                    obj[componentTags.COMPONENTSTATUS_TAG] = tagDetails.value;
                    obj[componentTags.CHECKCOMPONENTIDRESULT_TAG] = CheckComponentResult;
                    let payload = utility.assignDataToSchema(obj, componentCheckSchema);
                    payload.timestamp = plcdata.timestamp;
                    payload.assetid = substation.assetid;
                    componentCheckPayload.push(payload);
                }
            } else {
                const obj = { ...{}, ...plcdata };
                obj[componentTags.LINEID_TAG] = lineid;
                obj[componentTags.SUBLINEID_TAG] = sublineid;
                obj[componentTags.SUBSTATIONID_TAG] = substationid;
                obj[componentTags.SUBSTATIONNAME_TAG] = substationname;
                obj[componentTags.PARAMETERCATEGORY_TAG] = defaults.componentID;
                obj[componentTags.CHECKCOMPONENTIDRESULT_TAG] = CheckComponentResult;
                let payload = utility.assignDataToSchema(obj, componentCheckSchema);
                payload.timestamp = plcdata.timestamp;
                payload.assetid = substation.assetid;
                componentCheckPayload.push(payload);
            }
            this.createElementMultipleRecords(componentCheckPayload);
        },
        /**
         * This method call the methods of the bound, rework, quanlity status of component
         * @param {Object} bomrecord 
         * @param {Object} result 
         */
        CheckComponentStatus(plcdata, bomrecord, result) {
            if (result.length > 0) {
                result = result[0];
                this.CheckQualityStatus(plcdata, bomrecord, result);
            } else {
                log.error(`${MESSAGESCODE.XXX04006} for ${bomrecord[bomDetailsTags.PARAMETERNAME_TAG]}`);
                this.writeMessageToKafka(plcdata, "XXX04006")
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG]] = ComponentValues.OK;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = true;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] = 0;
                this.postDatatoSocketPLCWrite(bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG], ComponentValues.OK);
                this.checkPriority(ComponentValues.OK);
                arrayOfComponent.push({ tagdetails: bomrecord, value: ComponentValues.OK });
            }
        },
        /**
         * Check Quality status of component
         * @param {Object} bomrecord 
         * @param {Object} result 
         */
        CheckQualityStatus(plcdata, bomrecord, result) {
            log.error(`Check Quality Status of ${bomrecord[bomDetailsTags.PARAMETERNAME_TAG]}, Quality Status ${result[componentTags.QUALITYSTATUS_TAG]}, ComponentSubstation : ${bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG]}`);
            if (result[componentTags.QUALITYSTATUS_TAG] == ComponentValues.OK) {
                log.error(`${MESSAGESCODE.XXX04003}`);
                this.writeMessageToKafka(plcdata, "XXX04003")
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG]] = ComponentValues.OK;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = true;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] = 0;
                this.postDatatoSocketPLCWrite(bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG], ComponentValues.OK);
                this.checkPriority(ComponentValues.OK);
                arrayOfComponent.push({ tagdetails: bomrecord, value: ComponentValues.OK });
            } else if (result[componentTags.QUALITYSTATUS_TAG] == ComponentValues.NG) {
                log.error(`${MESSAGESCODE.XXX04001}`);
                this.writeMessageToKafka(plcdata, "XXX04001")
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG]] = ComponentValues.NG;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = true;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] = 0;
                this.postDatatoSocketPLCWrite(bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG], ComponentValues.NG);
                this.checkPriority(ComponentValues.NG);
                arrayOfComponent.push({ tagdetails: bomrecord, value: ComponentValues.NG });
            } else if (result[componentTags.QUALITYSTATUS_TAG] == ComponentValues.REWORK) {
                log.error(`${MESSAGESCODE.XXX04002}`);
                this.writeMessageToKafka(plcdata, "XXX04002")
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG]] = ComponentValues.OK;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = true;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] = 0;
                this.postDatatoSocketPLCWrite(bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG], ComponentValues.OK);
                this.checkPriority(ComponentValues.REWORK);
                arrayOfComponent.push({ tagdetails: bomrecord, value: ComponentValues.OK });
            } else if (result[componentTags.QUALITYSTATUS_TAG] == ComponentValues.SCRAP) {
                log.error(`${MESSAGESCODE.XXX04004}`);
                this.writeMessageToKafka(plcdata, "XXX04004")
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG]] = ComponentValues.NG;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = true;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] = 0;
                this.postDatatoSocketPLCWrite(bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG], ComponentValues.NG);
                this.checkPriority(ComponentValues.SCRAP);
                arrayOfComponent.push({ tagdetails: bomrecord, value: ComponentValues.NG });
            } else {
                log.error(`${MESSAGESCODE.XXX04005}`);
                this.writeMessageToKafka(plcdata, "XXX04005")
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG]] = ComponentValues.OK;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = true;
                this[bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] = 0;
                this.postDatatoSocketPLCWrite(bomrecord[bomDetailsTags.COMPONENTSTATUS_TAG], ComponentValues.OK);
                this.checkPriority(ComponentValues.OK);
            }
        },
        /**
         * 
         */
        checkPriority(value) {
            if (value === ComponentValues.ERROR || CheckComponentResult == ComponentValues.ERROR) {
                CheckComponentResult = ComponentValues.ERROR;
            } else if (value === ComponentValues.NG || value == ComponentValues.SCRAP || CheckComponentResult === ComponentValues.NG) {
                CheckComponentResult = ComponentValues.NG;
            } else if (value === ComponentValues.OK || value == ComponentValues.REWORK || CheckComponentResult === ComponentValues.OK) {
                CheckComponentResult = ComponentValues.OK;
            } else {
                log.error(`Please check the quality status which is not 1,2,3,4 QualityStatus : ${value}`)
            }
        },
        /**
         * This method check recipe written on PLC. If not then retry for configurable number of count
         * @param {Object} data 
         */
        CheckComponentFeedbacktoPLC(data) {
            // check CheckComponentResult
            const bomcomponent = this.orderinfo.bomDetailsComponentForQ || [];
            for (var i = 0; i < bomcomponent.length; i++) {
                const component = bomcomponent[i];
                if (component[bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.componentID) {
                    const isValid = this[component[bomDetailsTags.COMPONENTSTATUS_TAG]] === data[staticTags.CHECKCOMPONENTIDRESULT_TAG] ? true : false;
                    if (!isValid && this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] < feebackWriteCount) {
                        clearTimeout(this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Timer']);
                        this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = false;
                        // plc polling is reduced to 50 ms
                        this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Timer'] = setTimeout(() => {
                            this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = true;
                        }, retryToPLCTimer);
                        this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count']++;
                        this.postDatatoSocketPLCWrite(component[bomDetailsTags.COMPONENTSTATUS_TAG], this[component[bomDetailsTags.COMPONENTSTATUS_TAG]]);
                    } else if (!isValid && this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Count'] === feebackWriteCount) {
                        this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = false;
                    } else if (isValid) {
                        // if all ok then stop validation
                        this[component[bomDetailsTags.COMPONENTSTATUS_TAG] + 'Flag'] = false;
                    }
                }
            }

            if (writeCheckComponentResultFlag) {
                // if CheckComponentResult value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = CheckComponentResult === data[staticTags.CHECKCOMPONENTIDRESULT_TAG] ? true : false;
                if (!isValid && checkComponentResultCount < feebackWriteCount) {
                    clearTimeout(writeCheckComponentResultTimer);
                    this.resetCheckComponentResult();
                    // plc polling is reduced to 50 ms
                    writeCheckComponentResultTimer = setTimeout(() => {
                        this.setCheckComponentResult();
                    }, retryToPLCTimer);
                    checkComponentResultCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTIDRESULT_TAG, CheckComponentResult);

                } else if (!isValid && checkComponentResultCount === feebackWriteCount) {
                    // after 3 times retry error in writing to PLC
                    this.resetCheckComponentResult();
                    // no need to write completed because default value is 0
                    // CheckComponentCompleted = 0;
                    // writeCheckComponentCompletedFlag = true;

                } else if (isValid) {
                    // if all ok then stop validation
                    this.resetCheckComponentResult();
                    writeCheckComponentCompletedFlag = true;
                }
            }

            // check CheckComponentCompleted
            if (writeCheckComponentCompletedFlag) {
                // if CheckComponentCompleted value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
                const isValid = CheckComponentCompleted === data[staticTags.CHECKCOMPONENTCOMPLETED_TAG] ? true : false;
                if (!isValid && checkComponentCompleteCount < feebackWriteCount) {
                    clearTimeout(writeCheckComponentCompletedTimer);
                    this.resetCheckComponentCompleted()
                    // plc polling is reduced to 50 ms
                    writeCheckComponentCompletedTimer = setTimeout(() => {
                        this.setCheckComponentCompleted()
                    }, retryToPLCTimer);
                    checkComponentCompleteCount++;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTCOMPLETED_TAG, CheckComponentCompleted);
                } else if (!isValid && checkComponentCompleteCount === feebackWriteCount) {
                    checkComponentCompleteCount++;
                    // after 3 times retry error in writing to PLC
                    this.resetCheckComponentCompleted();

                } else if (isValid) {
                    // if all ok then stop validation
                    this.resetCheckComponentCompleted();
                }
            }
        },
        /**
         * Reset the values i.e. who write who reset
         * @param {Object} data 
         */
        resetAck(data) {
            // reset ComponentCheckResult, CheckComponentCompleted
            const isCheckComponentCompleted = 0 === data[staticTags.CHECKCOMPONENTCOMPLETED_TAG] ? true : false;
            // wait for 2 seconds and then reset values
            if (data[staticTags.COMPONENTCHECKTRIGGER_TAG] == 0 && !this.reset && resetCheckComponentCompletedFlag) {
                this.reset = true;
                setTimeout(() => {
                    this.write = true;
                }, resetValueDealyTime * 1000);
            } else if (this.write && resetCheckComponentCompletedFlag) {
                // reset CheckInNGCode
                if (resetCheckComponentCompletedFlag && !isCheckComponentCompleted && resetCheckComponentCompletedCount < feebackWriteCount) {
                    clearTimeout(this.resetCheckComponentCompletedTimer);
                    resetCheckComponentCompletedFlag = false;
                    // plc polling is reduced to 50 ms
                    this.resetCheckComponentCompletedTimer = setTimeout(() => {
                        resetCheckComponentCompletedFlag = true;
                    }, retryToPLCTimer);

                    resetCheckComponentCompletedCount++;
                    CheckComponentResult = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTIDRESULT_TAG, CheckComponentResult);
                    CheckComponentCompleted = 0;
                    this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTCOMPLETED_TAG, CheckComponentCompleted);
                    const bomcomponent = this.orderinfo.bomDetailsComponentForQ;
                    for (var i = 0; i < bomcomponent.length; i++) {
                        const component = bomcomponent[i];
                        if (component[bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.componentID) {
                            this.postDatatoSocketPLCWrite(component[bomDetailsTags.COMPONENTSTATUS_TAG], 0);
                        }
                    }

                } else if (!isCheckComponentCompleted && resetCheckComponentCompletedCount === feebackWriteCount) {
                    // after 3 times retry error in write reset values on PLC
                    resetCheckComponentCompletedFlag = false;

                } else if (isCheckComponentCompleted) {
                    // reset values written successfully on PLC
                    resetCheckComponentCompletedFlag = false;
                }
            }
        },
        /**
        * This method createMultiple records for components
        * @param {*} payload 
        */
        async createElementMultipleRecords(payload) {
            const elementName = elements.componentcheck;
            try {
                log.trace(`Component Check Payload ${JSON.stringify(payload)}`);
                const response = await elementService.createElementMultipleRecords(elementName, payload)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    log.error(`Record saved successfully in ShopWorx for componentcheck data  ${JSON.stringify(response.data)}`);
                    // componenet check result based on  priority for NG if one component id is error and another is NG then write NG to the componentcheckresult register
                    log.error(`Priority value for CheckComponentResult : ${CheckComponentResult}`);
                    this.setCheckComponentResult()
                    this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTIDRESULT_TAG, CheckComponentResult);
                    CheckComponentCompleted = ComponentValues.SUCCESSFUL;

                } else {
                    log.error(`Error in writing componentcheck data in ShopWorx ${JSON.stringify(response.data)}`);
                    CheckComponentResult = ComponentValues.SAVEDATAERROR;
                    this.setCheckComponentResult()
                    this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTIDRESULT_TAG, CheckComponentResult);
                    CheckComponentCompleted = ComponentValues.SUCCESSFUL;
                }
            } catch (ex) {
                log.error(`Exception in writing Component records to elementName : ${elementName}`);
                CheckComponentResult = ComponentValues.SAVEDATAERROR;
                this.setCheckComponentResult()
                this.postDatatoSocketPLCWrite(staticTags.CHECKCOMPONENTIDRESULT_TAG, CheckComponentResult);
                CheckComponentCompleted = ComponentValues.SUCCESSFUL;
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
            log.trace(`PLC Write Payload ${JSON.stringify(payload)}`);
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

        resetCheckComponentCompleted() {
            writeCheckComponentCompletedFlag = false;
        },
        setCheckComponentCompleted() {
            writeCheckComponentCompletedFlag = true;
        },
        resetCheckComponentResult() {
            writeCheckComponentResultFlag = false;
        },
        setCheckComponentResult() {
            writeCheckComponentResultFlag = true;
        },
        /**
         * Reset All flag when checkout triggered
         */
        resetAllFlag() {
            writeCheckComponentResultFlag = false;
            writeCheckComponentCompletedFlag = false;
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
