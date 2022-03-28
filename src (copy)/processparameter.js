'use strict'
module.exports.processparameter = processparameter;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
function processparameter(config, substation, PARAMETERS, utility, tags, MESSAGESCODE, emitter) {
    const substationTags = tags.substationtags;
    const parameterTags = tags.parametertags;
    const componentTags = tags.componenttags;
    const staticTags = tags.statictags;
    const defaults = config.defaults;
    const elements = config.elements;
    let lineid = substation[substationTags.LINEID_TAG];
    let sublineid = substation[substationTags.SUBLINEID_TAG];
    let substationname = substation[substationTags.NAME_TAG];
    let substationid = substation[substationTags.SUBSTATIONID_TAG];
    const log = bunyan.createLogger({ name: `ProcessParameter_${substationid}`, level: config.logger.loglevel });
    return {
        /**
         */
        getProcessParameter() {
            const processparameters = [];
            PARAMETERS.parametersList.filter((item) => {
                if (item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.processparameters || item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.subprocessparameters || item[parameterTags.PARAMETERCATEGORY_TAG] === defaults.subprocessresult) {
                    processparameters.push(item);
                }
            })
            return processparameters;
        },
        /**
         * This method prepare the payload of process parameter
         * @param {Object} data 
         */
        processMESParametersPayload(data) {
            const processParameters = this.getProcessParameter();
            let processParameterArray = [];

            for (var param in processParameters) {
                const obj = {}
                obj[componentTags.LINEID_TAG] = lineid;
                obj[componentTags.SUBLINEID_TAG] = sublineid;
                obj[componentTags.SUBSTATIONID_TAG] = substationid;
                obj[componentTags.SUBSTATIONNAME_TAG] = substationname;
                obj[componentTags.MAINID_TAG] = data[staticTags.MAINID_TAG];
                const paramObj = processParameters[param];
                if (data[paramObj[parameterTags.PARAMETERNAME_TAG]] || data[paramObj[parameterTags.PARAMETERNAME_TAG]] === 0) {
                    obj[parameterTags.PARAMETERNAME_TAG] = paramObj[parameterTags.PARAMETERNAME_TAG];
                    obj[parameterTags.PARAMETERVALUE_TAG] = data[paramObj[parameterTags.PARAMETERNAME_TAG]];
                    processParameterArray.push(obj);
                }
            }
            return processParameterArray;
        },
        /**
         * This method prepare the payload of process parameter
         * @param {Object} data 
         */
        processParametersPayload(data, prefix) {
            const processParameters = this.getProcessParameter();
            let processParameterArray = [];
            const obj = {}
            obj[componentTags.LINEID_TAG] = lineid;
            obj[componentTags.SUBLINEID_TAG] = sublineid;
            obj[componentTags.SUBSTATIONID_TAG] = substationid;
            obj[componentTags.SUBSTATIONNAME_TAG] = substationname;
            obj[componentTags.MAINID_TAG] = data[staticTags.MAINID_TAG];
            let isParam = false;
            for (var param in processParameters) {
                const paramObj = processParameters[param];
                if (data[paramObj[parameterTags.PARAMETERNAME_TAG]] || data[paramObj[parameterTags.PARAMETERNAME_TAG]] === 0) {
                    isParam = true;
                    if (prefix) {
                        obj[`${prefix}_${paramObj[parameterTags.PARAMETERNAME_TAG]}`] = `${data[paramObj[parameterTags.PARAMETERNAME_TAG]]}`;
                    } else {
                        obj[paramObj[parameterTags.PARAMETERNAME_TAG]] = data[paramObj[parameterTags.PARAMETERNAME_TAG]];
                        obj[paramObj[parameterTags.PARAMETERID_TAG]] = data[paramObj[parameterTags.PARAMETERNAME_TAG]];
                    }
                }
            }
            obj.timestamp = data.timestamp;
            obj.assetid = substation.assetid;
            if (isParam) {
                processParameterArray.push(obj);
            }
            return processParameterArray;
        },
        /**
         * This method write update the tracability element using mainid
         * @param {Object} obj 
         */
        async WriteParameterInTracabilityElement(obj) {
            const elementName = elements.traceability || 'traceability';
            try {
                if (obj.length > 0) {
                    let data = obj[0];
                    let query = `query=${componentTags.MAINID_TAG}=="${data[staticTags.MAINID_TAG]}"`;
                    let payload = data;
                    debugger;
                    const response = await elementService.upsertElementRecordsByQuery(elementName, payload, query);
                    if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                        log.error(`Process Parameters updated in ${elementName}`);
                    } else {
                        // check authentication
                        utility.checkSessionExpired(response.data);
                    }
                } else {
                    // no process parameters
                }
            } catch (ex) {
                log.error(`Exception in write / update process parameters ${ex}`);
            }
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