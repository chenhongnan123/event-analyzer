'use strict'
module.exports.reworkcheck = reworkcheck;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const bunyan = NodePackage.bunyan;
const ReworkCheckResultValues = require('../utils/constant').reworkcheckresult;
const InterfaceService = require('../service/interface.service').InterfaceService;


function reworkcheck(config, substation, ORDER, utility, tags, MESSAGESCODE) {
  const substationTags = tags.substationtags;
  const orderdetailsTags = tags.orderdetailstags;
  const staticTags = tags.statictags;
  const parameterTags = tags.parametertags;
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

  let writeReworkCheckResultFlag = false;
  let ReworkCheckResult;
  let writeReworkCheckResultTimer;
  let ReworkCheckResultCount = 0;

  let writeReworkCheckCompletedFlag = false;
  let ReworkCheckCompleted;
  let ReworkCheckCompleteCount = 0;
  let writeReworkCheckCompleteTimer;

  let resetReworkCheckCompletedFlag = false;

  let resetReworkCheckCompletedCount = 0;

  let processDataToPLC = [];
    let processDataToPLCFlag = false;
    let processDataToPLCCount = 0;
    let processDataToPLCTimer;

  const log = bunyan.createLogger({ name: `ReworkCheck${substationid}`, level: config.logger.loglevel });

  return {
    /**
       * This method process reworkchecktrigger
       * @param {Object} data
       */
    processStationData(data1) {
      let data = utility.cloneDeep(data1);
      let removePrefix = 'q_';
      let removeParameter = 's_';
      data = utility.modifyObject(data, removePrefix, removeParameter);
      // check if feedback is written successfully on PLC or not
      if (data[staticTags.REWORKCHECKTRIGGER_TAG] === 1) {
        this.ReworkCheckFeedbacktoPLC(data);
      }
      if (!data[staticTags.REWORKCHECKTRIGGER_TAG]) {
        if (previousvalidatebit) {
          resetReworkCheckCompletedFlag = true;
          resetReworkCheckCompletedCount = 0;
        }
        this.resetAck(data);
      }
      if (!data[staticTags.REWORKCHECKTRIGGER_TAG]) {
        this.restAllFlag();
        previousvalidatebit = 0;
      }

      if (previousvalidatebit === 0 && data[staticTags.REWORKCHECKTRIGGER_TAG] === 1) {
        log.error(`Reworkcheck Triggered ${JSON.stringify(data)}`);
        previousvalidatebit = 1;
        processDataToPLCCount = 0;
        ReworkCheckResult = 0;
        resetReworkCheckCompletedFlag = false;
        this.write = false;
        this.reset = false;
        this.mainIdCount = 0;
        this.CommonReworkCheck(data);
      }
    },
    /**
      * This method check recipe written on PLC. If not then retry for configurable number of count
      * @param {Object} data
      */
    ReworkCheckFeedbacktoPLC(data) {
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
      // reset reworkcheckresult, reworkcheckng, reworkcheckprocesscode and reworkcheckcompleted
      const isReworkCheckCompleted = (0 === data[staticTags.REWORKCHECKCOMPLETED_TAG])
      && (0 === data[staticTags.REWORKCHECKRESULT_TAG])  ? true : false;
      // wait for 2 seconds and then reset values
      if (!this.reset && resetReworkCheckCompletedFlag) {
        this.reset = true;
        setTimeout(() => {
          this.write = true;
        }, resetValueDealyTime * 1000);
      } else if (this.write && resetReworkCheckCompletedFlag) {
        // reset ReworkCheckCompleted
        if (resetReworkCheckCompletedFlag && !isReworkCheckCompleted && resetReworkCheckCompletedCount < feebackWriteCount) {
          clearTimeout(this.resetReworkcheckCompletedTimer);
          resetReworkCheckCompletedFlag = false;
          // plc polling is reduced to 50 ms
          this.resetReworkcheckCompletedTimer = setTimeout(() => {
            resetReworkCheckCompletedFlag = true;
          }, retryToPLCTimer);
          resetReworkCheckCompletedCount++;
          ReworkCheckResult = 0;
          this.virtualMainId = '';
          ReworkCheckCompleted = 0;
          processDataToPLC = this.prepareProcessData();
          this.writeProcessData();
        } else if (!isReworkCheckCompleted && resetReworkCheckCompletedCount === feebackWriteCount) {
          log.error(`Error in Reset ReworkCheckCompleted`);
          resetReworkCheckCompletedCount++;
          // after 3 times retry error in write reset values on PLC
          resetReworkCheckCompletedFlag = false;
        } else if (isReworkCheckCompleted) {
          // reset values written successfully on PLC
          resetReworkCheckCompletedFlag = false;
        }
      }
    },
    CommonReworkCheck(data) {
      const isMainID = this.checkMainId(data);
      if (isMainID) {
        // MAINID/CARRIERID Present in PLC data
        this.getReworkInfoFromMES(data);
      }
    },
    checkMainId(plcdata) {
      if (plcdata[staticTags.MAINID_TAG]) {
        // MAINID/CARRIERID Present in PLC data
        return true;
      } else {
        ReworkCheckResult = ReworkCheckResultValues.MISSINGDATA;
        processDataToPLC = this.prepareProcessData();
        processDataToPLCFlag = true;
        this.writeProcessData();
        return false;
      }
    },
    async getReworkInfoFromMES(data) {
      const head = {
        "part_no_id": data[staticTags.MAINID_TAG],
      };
      const response = await InterfaceService.getRework(head);
      if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (response.data.returncode === '0') {
          log.error(`Rework Commit Successfully ${JSON.stringify(response.data)}`);
          this.validateReworkInfo(data, response.data.head);
        } else  if (response.data.returncode === '-1') {
          log.error(`Rework Commit error`);
          log.error(response.data);
          if (response.data.returnmessage == '1001') {
            ReworkCheckResult = 21;
          } else if (response.data.returnmessage == '1002') {
            ReworkCheckResult = 22;
          } else if (response.data.returnmessage == '1003') {
            ReworkCheckResult = 23;
          } else {
            ReworkCheckResult = ReworkCheckResultValues.ERROR;
          }
        } else {
          log.error(`Rework Commit error`);
          log.error(response.data);
          ReworkCheckResult = ReworkCheckResultValues.ERROR;
        }
      } else {
        log.error(`Rework Commit error`);
        log.error(response.data);
        ReworkCheckResult = ReworkCheckResultValues.ERROR;
      }
      processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
    },
    async validateReworkInfo(plcdata, reworkinfo) {
      const {
        work_center,
        order_id,
        rework_port,
        part_no_id,
      } = reworkinfo;
      try {
        // get old partstatus
        log.error(`Rework Response${JSON.stringify(reworkinfo)}`);
        let partstatusquery = `query=ordername=="${order_id}"`;
        partstatusquery += `%26%26mainid=="${part_no_id}"`
        partstatusquery += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
        log.error(`Rework Query ${partstatusquery}`);
        const oldresponse = await elementService.getElementRecords(
          config.elements.partstatus || 'partstatus',
          partstatusquery
        );
        if (oldresponse.status == utility.HTTP_STATUS_CODE.SUCCESS) {
          if (oldresponse.data.results.length > 0) {
            const oldPartStatus = oldresponse.data.results[0];
            delete oldPartStatus._id;
            delete oldPartStatus.modestatus;
            delete oldPartStatus.overallresult;
            delete oldPartStatus.substationname;
            delete oldPartStatus.substationid;
            // add new rework status
            const substationresponse = await elementService.getElementRecords(
              config.elements.substation || 'substation',
              `query=reworkcode=="${work_center}"&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`
            );
            if (substationresponse.status == utility.HTTP_STATUS_CODE.SUCCESS) {
              if (substationresponse.data.results.length > 0) {
                const substation = substationresponse.data.results[0];
                const runningOrder = ORDER.runningOrder[0];
                let payload = {
                  ...oldresponse.data.results[0],
                  ordername: runningOrder.orderdata.ordername,
                  ordernumber: runningOrder.orderdata.ordernumber,
                  ordertype: runningOrder.orderdata.ordertype,
                  productid: runningOrder.orderdata.productid,
                  producttypename: runningOrder.orderdata.productname,
                  // substationid: substation[substationTags.SUBSTATIONID_TAG],
                  // substationname: substation[substationTags.NAME_TAG],
                  substationid: 'substation-262',
                  substationname: 'OP100',
                  overallresult: 1,
                  modestatus: 1
                };
                payload.assetid = config.assetid || 4;
                const response = await elementService.createElementRecord(
                  config.elements.partstatus || 'partstatus',
                  payload
                );
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                  log.error(
                    `Record saved successfully in ShopWorx for new rework ${JSON.stringify(
                      response.data
                    )}`
                  );
                  ReworkCheckResult = ReworkCheckResultValues.OK;
                  this.setVirtualMainId(part_no_id);
                  processDataToPLC = this.prepareProcessData();
                  processDataToPLCFlag = true;
                  this.writeProcessData();
                } else {
                  log.error(
                    `Error in writing new rework data in ShopWorx ${JSON.stringify(
                      response.data
                    )}`
                  );
                  utility.checkSessionExpired(response.data);
                  ReworkCheckResult = ReworkCheckResultValues.ERROR;
                  processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
                }
                // if (substation.forbiddenport !== rework_port) {

                // } else {
                //   log.error(
                //     `Error rework_port : ${rework_port} for work_center : ${work_center}, Should not Product in this rework port`
                //   );
                //   ReworkCheckResult = ReworkCheckResultValues.ERROR;
                //   this.setReworkCheckResultFlag();
                //   this.postDatatoSocketPLCWrite(staticTags.REWORKCHECKRESULT_TAG, ReworkCheckResult);
                // }
              } else {
                log.error(
                  `Error in getting substation data in ShopWorx ${JSON.stringify(
                    substationresponse.data
                  )}`
                );
                utility.checkSessionExpired(substationresponse.data);
                ReworkCheckResult = ReworkCheckResultValues.ERROR;
                processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
              }
            } else {
              log.error(
                `Error in getting substation data in ShopWorx ${JSON.stringify(
                  substationresponse.data
                )}`
              );
              utility.checkSessionExpired(substationresponse.data);
              ReworkCheckResult = ReworkCheckResultValues.ERROR;
              processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
            }
          } else {
            log.error(
              `Error in getting partstatus data in ShopWorx ${JSON.stringify(
                oldresponse.data
              )}`
            );
            utility.checkSessionExpired(oldresponse.data);
            ReworkCheckResult = ReworkCheckResultValues.ERROR;
            processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
          }
        } else {
          log.error(
            `Error in getting partstatus data in ShopWorx ${JSON.stringify(
              oldresponse.data
            )}`
          );
          utility.checkSessionExpired(oldresponse.data);
          ReworkCheckResult = ReworkCheckResultValues.ERROR;
          processDataToPLC = this.prepareProcessData();
          processDataToPLCFlag = true;
          this.writeProcessData();
        }
      } catch (error) {
        log.error(`Validate Rework Err: ${error}`);
        ReworkCheckResult = ReworkCheckResultValues.ERROR;
        processDataToPLC = this.prepareProcessData();
              processDataToPLCFlag = true;
              this.writeProcessData();
      }
    },
    setVirtualMainId(mainid) {
      if (mainid) {
        log.info(`mainid is ${mainid}`);
        this.virtualMainId = mainid;
      } else {
        log.error(`Can not set or write mainid to PLC`);
        this.virtualMainId = null;
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
      if (this.virtualMainId != null) {
        let payload = {};
        payload[parameterTags.SUBSTATIONID_TAG] = substationid;
        payload.name = staticTags.VIRTUALMAINID_TAG;
        payload.value = this.virtualMainId;
        obj.push(payload);
      }

      if (ReworkCheckResult != null) {
        let payload = {};
        payload[parameterTags.SUBSTATIONID_TAG] = substationid;
        payload.name = staticTags.REWORKCHECKRESULT_TAG;
        payload.value = ReworkCheckResult;
        obj.push(payload);
      }
      let payload = {};
      payload[parameterTags.SUBSTATIONID_TAG] = substationid;
      payload.name = staticTags.REWORKCHECKCOMPLETED_TAG;
      payload.value = 1;
      if (ReworkCheckResult == 0) {
        payload.value = 0;
      }
      obj.push(payload);

      return obj;
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
          value: item.value,
        };
      });
      log.error(`PLC Write Payload ${JSON.stringify(payload)}`);
      let url = `${socketio.protocol}://${socketio.host}:${socketio.port}/${socketio.namespace}/${socketio.eventname}_plcwrite`;
      try {
        let response = await socketService.post(url, payload);
        log.trace(`Payload for Pre-Analyzer ${JSON.stringify(payload)}`);
        if (
          response &&
          response.status == utility.HTTP_STATUS_CODE.SUCCESS &&
          response.data
        ) {
          log.trace(
            `Data send successfully on socket for ${substationid} - ${JSON.stringify(
              response.data
            )}`
          );
        } else {
          log.error(
            `Error in sending data to socket for PLC Live bit status code ${
              response.status
            } ${JSON.stringify(response.data)}`
          );
        }
      } catch (ex) {
        log.error(`Exception in writing data to socket ${ex}`);
      }
    },
    resetReworkCheckResultFlag() {
      writeReworkCheckResultFlag = false;
    },
    setReworkCheckResultFlag() {
      writeReworkCheckResultFlag = true;
    },
    restAllFlag() {

      processDataToPLCFlag = false;
    },
  }
}