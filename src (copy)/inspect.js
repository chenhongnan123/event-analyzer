'use strict'
module.exports.inspect = inspect;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;

function inspect(config, substation, ORDER, utility, tags, MESSAGESCODE, emitter) {
  const substationTags = tags.substationtags;
  const socketio = config.socketio;
  const feedbacktoplcsocketio = config.feedbacktoplcsocketio;
  const defaults = config.defaults;
  const parameterTags = tags.parametertags;
  const staticTags = tags.statictags;

  let lineid = substation[substationTags.LINEID_TAG];
  let sublineid = substation[substationTags.SUBLINEID_TAG];
  let stationname = substation[substationTags.NAME_TAG];
  let substationid = substation[substationTags.SUBSTATIONID_TAG];
  let stationid = substation[substationTags.STATIONID_TAG];
  let erpcode = substation[substationTags.ERPCODE_TAG];
  let reworkpcode = substation[substationTags.REWORKCODE_TAG];
  const log = bunyan.createLogger({ name: `Inspect_${substationid}`, level: config.logger.loglevel });
  const maxPLCRetryCount = defaults.maxPLCRetryCount;
  const plcRetryDelay = 100;
  let counter = 0;

  let writeInspectFlag = false;
  let writeInspectTimer;

  return {
    inspectresult: null,
    /**
      * Update Station Infomration
      */
    updateStationInfomraton(stationInfo) {
      lineid = stationInfo[substationTags.LINEID_TAG];
      sublineid = stationInfo[substationTags.SUBLINEID_TAG];
      stationname = stationInfo[substationTags.NAME_TAG];
      substationid = stationInfo[substationTags.SUBSTATIONID_TAG];
      stationid = substation[substationTags.STATIONID_TAG];
      erpcode = substation[substationTags.ERPCODE_TAG];
      reworkpcode = substation[substationTags.REWORKCODE_TAG];
    },
    /**
      * Intialize the socket listener on startup of E.A.
      */
    initEmitter() {
      emitter.on('inspect', (data) => {
        const inspectERPCode = data[substationTags.ERPCODE_TAG];
        if (inspectERPCode === erpcode && !writeInspectFlag) {
          log.error(`Inspect trigger: ${JSON.stringify(data)}`)
          log.error(`Inspect Write: ${erpcode}`)
          counter = 0;
          this.inspectresult = Number(data.inspectresult);
          writeInspectFlag = true;
          this.postDatatoSocketPLCWrite(staticTags.INSPECTRESULT_TAG, this.inspectresult);
        }
      })
    },
    processStationData(data) {
      if (writeInspectFlag) {
        const isValid = this.inspectresult === data[staticTags.INSPECTRESULT_TAG] ? true : false;
        if (!isValid && counter < maxPLCRetryCount) {
          clearTimeout(writeInspectTimer);
          writeInspectFlag = false;
          // plc polling is reduced to 50 ms
          writeInspectTimer = setTimeout(() => {
            writeInspectFlag = true;
          }, plcRetryDelay);
          counter++;
          log.error(`Try to Write Feedback to PLC as ${this.inspectresult}`);
          this.postDatatoSocketPLCWrite(staticTags.INSPECTRESULT_TAG, this.inspectresult);

        } else if (!isValid && counter === maxPLCRetryCount) {
          // after 3 times retry error in writing to PLC
          log.error('Fail to Write InspectResult to PLC');
          writeInspectFlag = false;

        } else if (isValid) {
          // if all ok then stop validation
          writeInspectFlag = false;
          this.inspectresult = null;
          log.error(`Success  Write Feedback to PLC as ${this.inspectresult}`);
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
  };
}