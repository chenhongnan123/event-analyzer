'use strict'
module.exports.componentparameter = componentparameter;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const ComponentValues = require('../utils/constant').componentcheckresult;
const CheckOutValues = require('../utils/constant').checkoutresult;
function componentparameter(config, substation, PARAMETERS, utility, tags, MESSAGESCODE) {
    const substationTags = tags.substationtags;
    const parameterTags = tags.parametertags;
    const componentTags = tags.componenttags;
    const orderdetailsTags = tags.orderdetailstags;
    const staticTags = tags.statictags;
    const bomDetailsTags = tags.bomdetialsTags;
    const defaults = config.defaults;
    const elements = config.elements;
    let retryServerTimer = defaults.retryServerTimer; // in seconds
    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let substationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    let componentSchema = [];
    const log = bunyan.createLogger({ name: `ComponentParameter_${substationid}`, level: config.logger.loglevel });
    return {
        async getComponentSchema() {
            const elementName = elements.component;
            try {
                const response = await elementService.getElement(elementName)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results) {
                        componentSchema = response.data.results.tags;
                    } else {
                        log.error(`Error in getting schema for element : ${elementName}`)
                        utility.checkSessionExpired(response.data);
                        await utility.setTimer(retryServerTimer);
                        await this.getComponentSchema();
                    }
                }
            } catch (ex) {
                log.error(`Exception in getting schema for element : ${elementName} ${ex}`);
                await utility.setTimer(retryServerTimer);
                await this.getComponentSchema();
            }
        },
        /**
         * This method get the list of component matche with id (i.e. component, batch, subassembly id)
         * @param {String} id 
         */
        getComponentID(id) {
            const componentID = [];
            PARAMETERS.parametersList.filter((item) => {
                if (item[parameterTags.PARAMETERCATEGORY_TAG] === id) {
                    componentID.push(item);
                }
            })
            return componentID;
        },
        /** */
        prepareComponentPayload(data, ORDER, component, componentID) {
            debugger;
            const { orderdata } = ORDER;
            let obj = {};
            obj = { ...orderdata, ...data };
            obj[componentTags.LINEID_TAG] = lineid;
            obj[componentTags.SUBLINEID_TAG] = sublineid;
            obj[componentTags.SUBSTATIONID_TAG] = substationid;
            obj[componentTags.SUBSTATIONNAME_TAG] = substationname;
            obj[componentTags.MAINID_TAG] = data[staticTags.MAINID_TAG];
            obj[componentTags.PARAMETERCATEGORY_TAG] = componentID;
            obj[componentTags.PARAMETERID_TAG] = component[bomDetailsTags.PARAMETERID_TAG];
            obj[componentTags.COMPONENTNAME_TAG] = component[bomDetailsTags.PARAMETERNAME_TAG];
            obj[componentTags.COMPONENTVALUE_TAG] = data[component[bomDetailsTags.PARAMETERNAME_TAG]];
            let payload = utility.assignDataToSchema(obj, componentSchema);
            payload[componentTags.QUALITYSTATUS_TAG] = ComponentValues.DEFAULT;
            return payload;
        },
        /** */
        componentPayload(data, ORDER, substationresult) {
            const componentArray = [];
            let isAllComponentIdPresent = true; debugger;
            if (ORDER.orderdata && ORDER.orderdata[orderdetailsTags.BOMID_TAG]) {
                const bomcomponent = ORDER.bomDetailsComponentForS;
                for (var i = 0; i < bomcomponent.length; i++) {
                    const component = bomcomponent[i];
                    if (data[component[bomDetailsTags.PARAMETERNAME_TAG]] && component[bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.componentID && component[bomDetailsTags.SAVEDATA_TAG]) {
                        let payload = this.prepareComponentPayload(data, ORDER, component, defaults.componentID)
                        const boundComponent = ORDER.bomDetailsQualityStatusForS
                        for (var j = 0; j < boundComponent.length; j++) {
                            if (boundComponent[j][bomDetailsTags.PARAMETERNAME_TAG] === component[bomDetailsTags.PARAMETERNAME_TAG] && boundComponent[j][bomDetailsTags.QUALITYSTATUS_TAG] && substationresult != CheckOutValues.TESTFAILED) {
                                payload[componentTags.QUALITYSTATUS_TAG] = substationresult;
                            }
                        }
                        payload.timestamp = data.timestamp;
                        payload.assetid = substation.assetid;
                        componentArray.push(payload);
                    } else if (component[bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.componentID && component[bomDetailsTags.SAVEDATA_TAG]) {
                        // BUG RA-I422
                        log.error(`Component Id not written on PLC Please check component ${component[bomDetailsTags.PARAMETERNAME_TAG]}`);
                        isAllComponentIdPresent = false;
                    } else if (data[component[bomDetailsTags.PARAMETERNAME_TAG]] && component[bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.batchID && component[bomDetailsTags.SAVEDATA_TAG]) {
                        let payload = this.prepareComponentPayload(data, ORDER, component, defaults.batchID)
                        payload.timestamp = data.timestamp;
                        payload.assetid = substation.assetid;
                        componentArray.push(payload);
                    } else if (data[component[bomDetailsTags.PARAMETERNAME_TAG]] && component[bomDetailsTags.PARAMETERCATEGORY_TAG] === defaults.subassemblyID && component[bomDetailsTags.SAVEDATA_TAG]) {
                        let payload = this.prepareComponentPayload(data, ORDER, component, defaults.subassemblyID)
                        payload.timestamp = data.timestamp;
                        payload.assetid = substation.assetid;
                        componentArray.push(payload);
                    } else {
                        log.error(`No data found for componentid ${component[bomDetailsTags.PARAMETERNAME_TAG]}`)
                    }
                }
            } else {
                log.error(`Bomid not present log all componentid and batchid present in parameters and plcdata`)
                // check componentID
                const componentId = this.getComponentID(defaults.componentID);
                for (var component in componentId) {
                    const componentObj = componentId[component];
                    if (data[componentObj[parameterTags.PARAMETERNAME_TAG]]) {
                        let payload = this.prepareComponentPayload(data, ORDER, component, defaults.componentID)
                        payload.timestamp = data.timestamp;
                        payload.assetid = substation.assetid;
                        componentArray.push(payload);
                    } else {
                        // BUG RA-I422
                        log.error(`No data found for componentid ${componentObj[parameterTags.PARAMETERNAME_TAG]}`);
                        isAllComponentIdPresent = false;
                    }
                }
                // check batchID
                const batchId = this.getComponentID(defaults.batchID);
                for (var batch in batchId) {
                    const batchObj = batchId[batch];
                    if (data[batchObj[parameterTags.PARAMETERNAME_TAG]]) {
                        let payload = this.prepareComponentPayload(data, ORDER, component, defaults.batchID)
                        payload[componentTags.QUALITYSTATUS_TAG] = substationresult;
                        payload.timestamp = data.timestamp;
                        payload.assetid = substation.assetid;
                        componentArray.push(payload);
                    } else {
                        log.error(`No data found for batchid ${batchObj[parameterTags.PARAMETERNAME_TAG]}`)
                    }
                }
                // check subassemblyID
                const subassemblyId = this.getComponentID(defaults.subassemblyID);
                for (var subassembly in subassemblyId) {
                    const subassemblyObj = componentId[subassembly];
                    if (data[subassemblyObj[parameterTags.PARAMETERNAME_TAG]]) {
                        let payload = this.prepareComponentPayload(data, ORDER, component, defaults.subassemblyID)
                        payload.timestamp = data.timestamp;
                        payload.assetid = substation.assetid;
                        componentArray.push(payload);
                    } else {
                        log.error(`No data found for subassemblyid ${subassemblyObj[parameterTags.PARAMETERNAME_TAG]}`)
                    }
                }
            }
            // BUG RA-I422
            debugger;
            return { componentArray: componentArray, isAllComponentIdPresent: isAllComponentIdPresent };
        }
    }
}