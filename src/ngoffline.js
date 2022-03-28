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

  let processDataToPLC = [];
    let processDataToPLCFlag = false;
    let processDataToPLCCount = 0;
    let processDataToPLCTimer;


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

        processDataToPLCCount = 0;
        NGOfflineResult = 0;

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
      if (processDataToPLCFlag) {
        const isValid = this.validateProcessData(data);
        if (!isValid && processDataToPLCCount < feebackWriteCount) {
            clearTimeout(processDataToPLCTimer);
            processDataToPLCFlag = false;
            // plc polling is reduced to 50 ms
            processDataToPLCTimer = setTimeout(() => {
                processDataToPLCFlag = true;
            }, retryToPLCTimer);
           processDataToPLCCount++;
            this.writeProcessData();
        } else if (!isValid &&processDataToPLCCount === feebackWriteCount) {
            log.error('Write Process Data Error');
            processDataToPLCFlag = false;
        } else if (isValid) {
            log.error('Write Process Data Success');
            // if all ok then stop validation
            processDataToPLCFlag = false;
            processDataToPLC = [];
        }
     }
    },
    /**
     * Reset the values i.e. who write who reset
     * @param {Object} data
     */
    resetAck(data) {
      const isNGOfflineCompleted = (0 === data[staticTags.NGOFFLINECOMPLETED_TAG])
      && (0 === data[staticTags.NGOFFLINERESULT_TAG]) ? true : false;
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
          NGOfflineCompleted = 0;
          processDataToPLC = this.prepareProcessData();
          this.writeProcessData();
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
        processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
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
              processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
            }
          } else {
            log.error(`No record found in partstatus for mainid ${plcdata[staticTags.MAINID_TAG]}`);
            NGOfflineResult = NGOfflineResultValues.ERROR;
            processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();

          }
        } else {
          utility.checkSessionExpired(response.data);
          log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`);
          NGOfflineResult = NGOfflineResultValues.ERROR;
          processDataToPLC = this.prepareProcessData();
          processDataToPLCFlag = true;
          this.writeProcessData();

        }
      } catch (ex) {
        log.error(`Exception to fetch data for element : ${elementName}`);
        const messageObject = ex.response ? ex.response.data : ex
        log.error(messageObject);
        NGOfflineResult = NGOfflineResultValues.ERROR;
        processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
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
              processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
            }
          } else {
            log.error(`No record found in substation for id ${lastStationData[checkoutTags.SUBSTATIONID_TAG]}`);
            NGOfflineResult = NGOfflineResultValues.ERROR;
            processDataToPLC = this.prepareProcessData();
            processDataToPLCFlag = true;
            this.writeProcessData();
          }
        } else {
          utility.checkSessionExpired(response.data);
          log.error(`Error in getting data from elementName : substation ${JSON.stringify(substationresponse.data)}`);
          NGOfflineResult = NGOfflineResultValues.ERROR;
          processDataToPLC = this.prepareProcessData();
          processDataToPLCFlag = true;
          this.writeProcessData();

        }

      } else {
        log.error(`mainid status : ${status}, NO NG`);
        NGOfflineResult = NGOfflineResultValues.STATUSNOK;
        processDataToPLC = this.prepareProcessData();
        processDataToPLCFlag = true;
        this.writeProcessData();
      }
    },
    writeProcessData() {
      this.processDataWriteEvent();
    },
    processDataWriteEvent() {
      const data = processDataToPLC;
      if (data.length) {
        //log.error(`Start Write Process Data`);
        //log.error(`Process Data: ${JSON.stringify(processDataToPLC)}`);
        this.postDatatoSocketPLCWrite(processDataToPLC);
      } else {
        log.error(`ProcessData not found`);
      }
    },
    validateProcessData(plcdata) {
      const data = processDataToPLC;
      if (data.length) {
        const okProcessData = [];
        for (let i = 0; i < data.length; i++) {
          const name = data[i].name;
          const value = data[i].value;
          if (typeof plcdata[name] === "number") {
            let decimalpoint = this.countDecimals(value, name, plcdata[name]);
            plcdata[name] = plcdata[name]
              ? +plcdata[name].toFixed(decimalpoint)
              : plcdata[name];
          }
          if (value == plcdata[name]) {
            okProcessData.push({
              [name]: plcdata[name],
            });
          }
        }
        //log.error(`ProcessData Valid: ${okProcessData.length === data.length}`);
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
        log.error(
          `Exeption in checking decimalcount parametername : ${param}, recipevalue : ${value}, plcvalue : ${plcval}`
        );
      }
      return value;
    },
    prepareProcessData(data) {
      let obj = data ? data : [];
      if (NGOfflineResult != null) {
        let payload = {};
        payload[parameterTags.SUBSTATIONID_TAG] = substationid;
        payload.name = staticTags.NGOFFLINERESULT_TAG;
        payload.value = NGOfflineResult;
        obj.push(payload);
      }
      let payload = {};
      payload[parameterTags.SUBSTATIONID_TAG] = substationid;
      payload.name = staticTags.NGOFFLINECOMPLETED_TAG;
      payload.value = 1;
      if (NGOfflineResult == 0) {
        payload.value = 0;
      }
      obj.push(payload);

      return obj;
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
      processDataToPLC = this.prepareProcessData();
      processDataToPLCFlag = true;
      this.writeProcessData();
    },
    /**
        * This method send the data to Pre-Analyzer for writing into PLC
        * @param {Object} payload
        */
     async postDatatoSocketPLCWrite(values) {
      const payload = values.map((item) => {
        return {
          [parameterTags.SUBSTATIONID_TAG]: substationid,
          [parameterTags.PARAMETERNAME_TAG]: item.name,
          value: item.value
        }
      });
        //log.error(`PLC Write Payload ${JSON.stringify(payload)}`);
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