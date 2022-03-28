'use strict'
module.exports.ngoffline = ngoffline;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const InterfaceService = require('../service/interface.service').InterfaceService;
const bunyan = NodePackage.bunyan;
const NGOfflineResultValues = require('../utils/constant').ngofflineresult;
const CheckInResultValues = require('../utils/constant').checkinresult;

function ngoffline(config, substation, ORDER, utility, tags, MESSAGESCODE) {
  const substationTags = tags.substationtags;
  const orderdetailsTags = tags.orderdetailstags;
  const checkoutTags = tags.checkouttags;
  const parameterTags = tags.parametertags;
  const staticTags = tags.statictags;
  const socketio = config.feedbacktoplcsocketio;
  const elements = config.elements;
  const defaults = config.defaults;
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

  let writeNGOfflineResultFlag = false;
  let NGOfflineResult;
  let writeNGOfflineResultTimer;
  let NGOfflineResultCount = 0;

  let writeNGOfflineCompletedFlag = false;
  let NGOfflineCompleted;
  let NGOfflineCompleteCount = 0;
  let writeNGOfflineCompleteTimer;

  let resetNGOfflineCompletedFlag = false;

  let resetNGOfflineCompletedCount = 0;

  const log = bunyan.createLogger({ name: `NGOffline_${substationid}`, level: config.logger.loglevel });

  return {
    /**
       * This method process ngofflinetrigger
       * @param {Object} data
       */
    processStationData(data1) {
      let data = utility.cloneDeep(data1);
      let removePrefix = 'q_';
      let removeParameter = 's_';
      data = utility.modifyObject(data, removePrefix, removeParameter);
      // check if feedback is written successfully on PLC or not
      if (data[staticTags.NGOFFLINETRIGGER_TAG] === 1) {
        this.NGOfflineFeedbacktoPLC(data);
      }
      if (!data[staticTags.NGOFFLINETRIGGER_TAG]) {
        if (previousvalidatebit) {
          resetNGOfflineCompletedFlag = true;
          resetNGOfflineCompletedCount = 0;
        }
        this.resetAck(data);
      }
      if (!data[staticTags.NGOFFLINETRIGGER_TAG]) {
        this.restAllFlag();
        previousvalidatebit = 0;
      }

      if (previousvalidatebit === 0 && data[staticTags.NGOFFLINETRIGGER_TAG] === 1) {
        log.error(`NGoffline Triggered ${JSON.stringify(data)}`);
        previousvalidatebit = 1;
        NGOfflineResultCount = 0;
        NGOfflineCompleteCount = 0;
        resetNGOfflineCompletedFlag = false;
        this.write = false;
        this.reset = false;
        this.CommonNGOffline(data);
      }
    },
    /**
      * This method check recipe written on PLC. If not then retry for configurable number of count
      * @param {Object} data
      */
    NGOfflineFeedbacktoPLC(data) {
      // check NGOfflineResult
      if (writeNGOfflineResultFlag) {
        // if NGOfflineResult value is not written properly to PLC then retry for 3 times with some delay i.e. 500ms
        const isValid = NGOfflineResult === data[staticTags.NGOFFLINERESULT_TAG] ? true : false;
        if (!isValid && NGOfflineResultCount < feebackWriteCount) {
          clearTimeout(writeNGOfflineResultTimer);
          this.resetNGOfflineResultFlag()
          // plc polling is reduced to 50 ms
          writeNGOfflineResultTimer = setTimeout(() => {
            this.setNGOfflineResultFlag()
          }, retryToPLCTimer);
          NGOfflineResultCount++;
          log.error(`Write Feedback to PLC as ${NGOfflineResult}`);
          this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);

        } else if (!isValid && NGOfflineResultCount === feebackWriteCount) {
          // after 3 times retry error in writing to PLC
          log.error(`Error in Writing NGOfflineResult`);
          this.resetNGOfflineResultFlag()

        } else if (isValid) {
          // if all ok then stop validation
          this.resetNGOfflineResultFlag()
          NGOfflineCompleted = 1;
          writeNGOfflineCompletedFlag = true;

        }
      }


      // NGOfflineCompleted
      if (writeNGOfflineCompletedFlag) {
        const isValid = NGOfflineCompleted === data[staticTags.NGOFFLINECOMPLETED_TAG] ? true : false;
        if (!isValid && NGOfflineCompleteCount < feebackWriteCount) {
          clearTimeout(writeNGOfflineCompleteTimer);
          writeNGOfflineCompletedFlag = false;
          // plc polling is reduced to 50 ms
          writeNGOfflineCompleteTimer = setTimeout(() => {
            writeNGOfflineCompletedFlag = true;
          }, retryToPLCTimer);

          NGOfflineCompleteCount++;
          this.postDatatoSocketPLCWrite(staticTags.NGOFFLINECOMPLETED_TAG, NGOfflineCompleted);

        } else if (!isValid && NGOfflineCompleteCount === feebackWriteCount) {
          log.error(`Error in Writing NGOfflineCompleted`);
          // after 3 times retry error in write NGOfflineCompleted on PLC
          writeNGOfflineCompletedFlag = false;
          // reset ngofflinecompleted

        } else if (isValid) {
          // NGOfflineCompleted written successfully on PLC
          writeNGOfflineCompletedFlag = false;
          // reset ngofflinecompleted
        }
      }
    },
    /**
     * Reset the values i.e. who write who reset
     * @param {Object} data
     */
    resetAck(data) {
      const isNGOfflineCompleted = 0 === data[staticTags.NGOFFLINECOMPLETED_TAG] ? true : false;
      // wait for 2 seconds and then reset values
      if (!this.reset && resetNGOfflineCompletedFlag) {
        this.reset = true;
        setTimeout(() => {
          this.write = true;
        }, resetValueDealyTime * 1000);
      } else if (this.write && resetNGOfflineCompletedFlag) {
        // reset NGOfflineCompleted
        if (resetNGOfflineCompletedFlag && !isNGOfflineCompleted && resetNGOfflineCompletedCount < feebackWriteCount) {
          clearTimeout(this.resetNGofflineCompletedTimer);
          resetNGOfflineCompletedFlag = false;
          // plc polling is reduced to 50 ms
          this.resetNGofflineCompletedTimer = setTimeout(() => {
            resetNGOfflineCompletedFlag = true;
          }, retryToPLCTimer);
          resetNGOfflineCompletedCount++;

          NGOfflineResult = 0;
          this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);

          NGOfflineCompleted = 0;
          this.postDatatoSocketPLCWrite(staticTags.NGOFFLINECOMPLETED_TAG, NGOfflineCompleted);

        } else if (!isNGOfflineCompleted && resetNGOfflineCompletedCount === feebackWriteCount) {
          log.error(`Error in Reset NGOfflineCompleted`);
          resetNGOfflineCompletedCount++;
          // after 3 times retry error in write reset values on PLC
          resetNGOfflineCompletedFlag = false;

        } else if (isNGOfflineCompleted) {
          // reset values written successfully on PLC
          resetNGOfflineCompletedFlag = false;
        }
      }
    },
    CommonNGOffline(data) {
      const isMainID = this.checkMainId(data);
      if (isMainID) {
        // MAINID/CARRIERID Present in PLC data
        this.checkLastStationPartStatus(data);
      }

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
        NGOfflineResult = NGOfflineResultValues.MISSINGDATA;
        this.setNGOfflineResultFlag();
        this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);
        return false;
      }
    },
    async checkLastStationPartStatus(plcdata) {
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
              // check the last substation result for mainid and orderid
              this.checkOverAllResult(plcdata, runningOrder, response.data.results[0]);
            }
            else {
              log.error(`No RunningOrder found for mainid ${plcdata[staticTags.MAINID_TAG]}`);
              NGOfflineResult = NGOfflineResultValues.ORDERNOK;
              this.setNGOfflineResultFlag();
              this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);
            }
          } else {
            log.error(`No record found in partstatus for mainid ${plcdata[staticTags.MAINID_TAG]}`);
            NGOfflineResult = NGOfflineResultValues.ERROR;
            this.setNGOfflineResultFlag();
            this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);

          }
        } else {
          utility.checkSessionExpired(response.data);
          log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`);
          NGOfflineResult = NGOfflineResultValues.ERROR;
          this.setNGOfflineResultFlag();
          this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);

        }
      } catch (ex) {
        log.error(`Exception to fetch data for element : ${elementName}`);
        const messageObject = ex.response ? ex.response.data : ex
        log.error(messageObject);
        NGOfflineResult = NGOfflineResultValues.ERROR;
        this.setNGOfflineResultFlag();
        this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);
      }
    },
    async checkOverAllResult(plcdata, runningOrder, lastStationData) {
      const status = lastStationData[checkoutTags.OVERALLRESULT_TAG];
      if (status == CheckInResultValues.NG) {
        let substationquery = `query=id=="${lastStationData[checkoutTags.SUBSTATIONID_TAG]}"`;
        substationquery += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
        const substationresponse = await elementService.getElementRecords(config.elements.substation || 'substation', substationquery);
        if (substationresponse.status == utility.HTTP_STATUS_CODE.SUCCESS) {
          if (substationresponse.data && substationresponse.data.results.length > 0) {
            const substation = substationresponse.data.results[0];
            const erpcode = substation[substationTags.ERPCODE_TAG];
            if (Number(erpcode) > 80108) {
              let reworkcode = substation[substationTags.REWORKCODE_TAG];
              await this.writeRecordInMES(plcdata, runningOrder, lastStationData, reworkcode)
            } else {
              log.error(`ng in the ${lastStationData[checkoutTags.SUBSTATIONID_TAG]} before 80108`);
              NGOfflineResult = NGOfflineResultValues.ERRSTATION;
              this.setNGOfflineResultFlag();
              this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);
            }
          } else {
            log.error(`No record found in substation for id ${lastStationData[checkoutTags.SUBSTATIONID_TAG]}`);
            NGOfflineResult = NGOfflineResultValues.ERROR;
            this.setNGOfflineResultFlag();
            this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);
          }
        } else {
          utility.checkSessionExpired(response.data);
          log.error(`Error in getting data from elementName : substation ${JSON.stringify(substationresponse.data)}`);
          NGOfflineResult = NGOfflineResultValues.ERROR;
          this.setNGOfflineResultFlag();
          this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);

        }

      } else {
        log.error(`mainid status : ${status}, NO NG`);
        NGOfflineResult = NGOfflineResultValues.STATUSNOK;
        this.setNGOfflineResultFlag();
        this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);
      }
    },
    async writeRecordInMES(plcdata, runningOrder, lastStationData, erpcode) {
      const head = {
        "order_id": runningOrder.orderdata[orderdetailsTags.ORDERNAME_TAG],
        "work_center": erpcode,
        "part_no_id": plcdata[staticTags.MAINID_TAG],
        "error_code": lastStationData[checkoutTags.CHECKOUTNGCODE_TAG].toString()
      };
      const response = await InterfaceService.commitPartNG(head);
      if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (response.data.returncode === '0') {
          log.error(`NG Part Commit Successfully`);
          NGOfflineResult = NGOfflineResultValues.OK;
        }
        else {
          log.error(`NG Part Commit error`);
          NGOfflineResult = NGOfflineResultValues.ERROR;

        }
      } else {
        log.error(`NG Part Commit error`);
        NGOfflineResult = NGOfflineResultValues.ERROR;
      }
      this.setNGOfflineResultFlag();
      this.postDatatoSocketPLCWrite(staticTags.NGOFFLINERESULT_TAG, NGOfflineResult);
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
    resetNGOfflineResultFlag() {
      writeNGOfflineResultFlag = false;
    },
    setNGOfflineResultFlag() {
      writeNGOfflineResultFlag = true;
    },
    restAllFlag() {

      writeNGOfflineResultFlag = false;
    },
  }
}