const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const _ = NodePackage.lodash;
const bunyan = NodePackage.bunyan;
const EventEmitter = NodePackage.EventEmitter;
EventEmitter.prototype._maxListeners = 0;
const emitter = new EventEmitter.EventEmitter();
const log = bunyan.createLogger({ name: 'utility', level: 20 })
/** @constant {Object} */
const DATA_TYPE = {
    STRING: "string",
    NUMBER: "number",
    BOOLEAN: "boolean",
    OBJECT: "object"
};

/** @constant {Object} */
const HTTP_STATUS_CODE = {
    SUCCESS: 200,
    ACCEPTED: 202,
    BAD_REQUEST: 406,
    NOT_ACCEPTABLE: 406,
    INTERNAL_SERVER_ERROR: 500
}
let requestTimeout = {
    timeout: 45 * 1000
}
let auth;
function setAuthInstance(authenticateObj) {
    auth = authenticateObj;
}
/**
 * Efficiently calculates the comma separated string
 * passed into the method. The input is expected in below format,
 * 
 * concat("This","is","an","example") return "Thisisanexample"
 *
 * @param {string} strings comma separated strings.
 */
const concat = (...strings) => {
    return _.reduce(strings, (accumulator, currentItem) => {
        return accumulator + currentItem;
    });
};

/**
 * Checks if give configuration parameter exists with given data types. If no then exit node js service 
 * pointing deficiency in perticular parameter.
 * 
 * @param {string} configParam 
 * @param {string} dataType 
 */
const checkIfExists = (configParam, configParamString, dataType) => {
    // check if configuration parameter exists in configuration file.
    if (typeof configParam != 'boolean' && !configParam) {
        log.fatal("Configuration parameter is invalid OR absent: " + configParamString);
        process.exit(1);
    }
    // check if configuration parameter has valid data type.
    if (typeof configParam != dataType) {
        log.fatal("Data type for configuration parameter '" + configParamString + "' must be: " + dataType);
        process.exit(1);
    }
}
/**
 * validate the configuration parameter is valid with given conditions
 * 
 */
const validateConfigfileParameters = (CONFIG) => {

    log.info('Validating Configuration file.');

    checkIfExists(CONFIG.industryid, "CONFIG.industryid", DATA_TYPE.NUMBER);
    checkIfExists(CONFIG.loginType, "CONFIG.loginType", DATA_TYPE.STRING);

    checkIfExists(CONFIG.server, "CONFIG.server", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.server.protocol, "CONFIG.server.protocol", DATA_TYPE.STRING);
    checkIfExists(CONFIG.server.host, "CONFIG.server.host", DATA_TYPE.STRING);
    checkIfExists(CONFIG.server.port, "CONFIG.server.port", DATA_TYPE.NUMBER);

    checkIfExists(CONFIG.socketio, "CONFIG.socketio", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.socketio.host, "CONFIG.socketio.host", DATA_TYPE.STRING);
    checkIfExists(CONFIG.socketio.port, "CONFIG.socketio.port", DATA_TYPE.NUMBER);
    checkIfExists(CONFIG.socketio.namespace, "CONFIG.socketio.namespace", DATA_TYPE.STRING);
    checkIfExists(CONFIG.socketio.eventname, "CONFIG.socketio.eventname", DATA_TYPE.STRING);

    checkIfExists(CONFIG.credential, "CONFIG.credential", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.credential.password, "CONFIG.credential.password", DATA_TYPE.STRING);
    checkIfExists(CONFIG.credential.identifier, "CONFIG.credential.identifier", DATA_TYPE.STRING);

    checkIfExists(CONFIG.kafkaEdge, "CONFIG.kafkaEdge", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.kafkaEdge.port, "CONFIG.kafkaEdge.port", DATA_TYPE.NUMBER);
    checkIfExists(CONFIG.kafkaEdge.autoCommit, "CONFIG.kafkaEdge.autoCommit", DATA_TYPE.BOOLEAN);
    checkIfExists(CONFIG.kafkaEdge.fetchMinBytes, "CONFIG.kafkaEdge.fetchMinBytes", DATA_TYPE.NUMBER);
    checkIfExists(CONFIG.kafkaEdge.fetchMaxBytes, "CONFIG.kafkaEdge.fetchMaxBytes", DATA_TYPE.NUMBER);

    checkIfExists(CONFIG.logger, "CONFIG.logger", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.logger.loglevel, "CONFIG.logger.loglevel", DATA_TYPE.NUMBER);

    checkIfExists(CONFIG.elements, "CONFIG.elements", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.elements.substation, "CONFIG.elements.substation", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.order, "CONFIG.elements.order", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.orderproduct, "CONFIG.elements.orderproduct", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.orderrecipe, "CONFIG.elements.orderrecipe", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.orderroadmap, "CONFIG.elements.orderroadmap", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.checkin, "CONFIG.elements.checkin", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.checkout, "CONFIG.elements.checkout", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.component, "CONFIG.elements.component", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.partstatus, "CONFIG.elements.partstatus", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.rework, "CONFIG.elements.rework", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.bomdetailsconfig, "CONFIG.elements.bomdetailsconfig", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.componentcheck, "CONFIG.elements.componentcheck", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.productionimage, "CONFIG.elements.productionimage", DATA_TYPE.STRING);
    checkIfExists(CONFIG.elements.productionimageinfo, "CONFIG.elements.productionimageinfo", DATA_TYPE.STRING);

    checkIfExists(CONFIG.defaults, "CONFIG.defaults", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.defaults.isPreviousDataIgnored, "CONFIG.defaults.isPreviousDataIgnored", DATA_TYPE.BOOLEAN);

    checkIfExists(CONFIG.status, "CONFIG.status", DATA_TYPE.OBJECT);
    checkIfExists(CONFIG.status.running, "CONFIG.status.running", DATA_TYPE.STRING);

    log.info('Configuration file successfully validated.');

};


/**
 * Throw Error.
 * 
 * @param {object} reply 
 * @param {object} err 
 */
const throwError = (reply, err) => {
    reply.code(500).send({ message: err });
}

/**
 * This function map the data with element schema
 * @param {object} data which contains actual data to log
 * @param {object} fields which contains schema of elements
 */
const assignDataToSchema = function (data, fields) {
    let postData = {};
    // log.info(" Map values with element schema ");
    // map values with element schmea
    // if prefix required for any element need to pass it to function as a param
    let prefix = '';
    if (fields.length > 0) {
        for (let i = 0; fields && i < fields.length; i++) {
            let tagname = prefix + fields[i].tagName;
            let choice = fields[i].emgTagType || '';
            switch (choice) {
                case "Int": case "Double": case "Float": case "Long":
                    if (data[tagname] || data[tagname] === 0) {
                        postData[fields[i].tagName] = (data[tagname] || data[tagname] === 0) ? +data[tagname] : data[tagname];
                    }
                    break;
                case "String":
                    if (data[tagname] || data[tagname] === '') {
                        let stringValue = data[tagname] ? data[tagname].toString() : data[tagname];
                        stringValue = stringValue ? stringValue.replace(/\u0000/g, '') : stringValue;
                        postData[fields[i].tagName] = stringValue ? stringValue.trim() : stringValue;
                    }
                    break;
                case "Boolean":
                    postData[fields[i].tagName] = data[tagname] || false;
                    break;
                default:
                    if (data[tagname] || data[tagname] == 0) {
                        postData[fields[i].tagName] = data[tagname];
                    }
            }
        }
    } else {
        postData = data;
    }
    return postData;
}
const checkSessionExpired = (data) => {
    if (data && data.errors && data.errors.errorCode === 'INVALID_SESSION') {
        log.error(`Session Id expired ${JSON.stringify(data.errors)}`);
        log.error(`Session Expired trying to reAuthenticate`);
        let isReAuth = true;
        auth.getAuthentication(isReAuth);
    }
}

const arrayUniqueByKey = (data, key) => {
    const unique = [...new Map(data.map(item =>
        [item[key], item])).values()];
    return unique;
}

const cloneDeep = (data) => {
    return JSON.parse(JSON.stringify(data))
}
/**
 * This method remove the prefix and remove parameter 
 * @param {*} data - PLC Data
 * @param {*} removePrefix - with this prefix parameter remove only prefix from PLC Data
 * @param {*} removeParameter - with this prefix parameter need to remove parameter from PLC data
 */
const modifyObject = (data, removePrefix, removeParameter) => {

    let newObj = {};
    Object.entries(data).forEach(([key, value]) => {
        let saveprefix = key.slice(0, 2);
        if (saveprefix == removePrefix) {
            newObj[key.split(removePrefix)[1]] = value;
        } else if (saveprefix !== removeParameter) {
            newObj[key] = value;
        } else {

        }
    });
    return newObj;
}
/**
 * When any API failed or need to wait before calling next function or step use this function
 * @param {Number} time Refer for adding delay time
 */
async function setTimer(time) {
    time = time || 1; // default time is 1 seconds if time not passed from function
    await new Promise(resolve => setTimeout(resolve, time * 1000));
}
module.exports = {
    HTTP_STATUS_CODE,
    requestTimeout,
    validateConfigfileParameters,
    setAuthInstance,
    concat,
    throwError,
    assignDataToSchema,
    checkSessionExpired,
    emitter,
    arrayUniqueByKey,
    cloneDeep,
    modifyObject,
    setTimer
};