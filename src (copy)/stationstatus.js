/**
 * Requirement
 * save the substation status record in SWX
 * once stationstatus changed, end the old record and start new record
 */

'use strict';
module.exports.stationstatus = stationstatus;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const socketService = require('../service/socket.service').SocketService;
const elementService = require('../service/element.service.js').ElementService;
const InterfaceService = require('../service/interface.service').InterfaceService;

const bunyan = NodePackage.bunyan;
const moment = NodePackage.moment;
const qs = NodePackage.qs;
// const StationStatusValue = require("../utils/constant").stationstatus;
function stationstatus(config, substation, PARAMETERS, ORDER, utility, tags, businessHours, businessHolidays, emitter) {
  const substationTags = tags.substationtags;
  const sublineTags = tags.sublinetags;
  const parameterTags = tags.parametertags;
  const orderdetailsTags = tags.orderdetailstags;
  const staticTags = tags.statictags;
  const checkoutTags = tags.checkouttags;
  const componentTags = tags.componenttags;
  const bomDetailsTags = tags.bomdetialsTags;
  const socketio = config.feedbacktoplcsocketio;
  const elements = config.elements;
  const defaults = config.defaults;
  let lineid = substation[substationTags.LINEID_TAG];
  let sublineid = substation[substationTags.SUBLINEID_TAG];
  let sublinename = substation[substationTags.SUBLINENAME_TAG];
  let substationname = substation[substationTags.NAME_TAG];
  let stationname = substation[substationTags.STATIONNAME_TAG];
  let substationid = substation[substationTags.SUBSTATIONID_TAG];
  let previousvalidatebit = 0;
  const maxServerRetryCount = defaults.maxServerRetryCount;
  let retryServerTimer = defaults.retryServerTimer; // in seconds
  const feebackWriteCount = defaults.maxPLCRetryCheckoutFeedbackCount;
  const retryToPLCTimer = defaults.retryToPLCTimer; // in milliseconds
  const resetValueDealyTime = defaults.resetValueDealyTime || 2;
  const stationstatusTags = tags.stationstatustags;
  let stationstatus = -1;
  let stationStatusSchema = [];

  const log = bunyan.createLogger({
    name: `stationstatus${substationid}`,
    level: config.logger.loglevel,
  });
  return {
    downtimestartflag: false,
    startup: true,
    ngreasonList: [],
    async init() {
      this.getNGReasonList();
      this.initEmitter();
    },
    /**
        * Intialize the socket listener on startup of E.A.
        */
    initEmitter() {
      /**
       * Order update Event received from ShopWorx
       * One line has one Order running at a time
       */
      emitter.on('ngreason', (data) => {
        log.error(`ngreason event triggered ${JSON.stringify(data)}`);
        this.getNGReasonList();
      })

    },
    async getNGReasonList() {
      const ngreasonrecord = await elementService.getElementRecords(elements.ngreason || 'ngreason');
      if (ngreasonrecord.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (ngreasonrecord.data && ngreasonrecord.data.results && ngreasonrecord.data.results.length > 0) {
          // use only update API
          this.ngreasonList = ngreasonrecord.data.results;
          log.error('NG Reason Pull Successfully');
        } else {
          log.error(`no data in elementName : ${elements.ngreason || 'ngreason'} ${JSON.stringify(ngreasonrecord.data)}`);
          this.ngreasonList = [];
        }
      } else {
        log.error(`Error in getting data from elementName : ${elements.ngreason || 'ngreason'} ${JSON.stringify(ngreasonrecord.data)}`);
        utility.checkSessionExpired(ngreasonrecord.data);
        await utility.setTimer(retryServerTimer);
        this.getNGReasonList(plcdata, now);
      }
    },
    async getStationStatusSchema() {
      const elementName = elements.stationstatus;
      try {
        const response = await elementService.getElement(elementName);
        if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
          if (response.data && response.data.results) {
            stationStatusSchema = response.data.results.tags;
          } else {
            log.error(`Error in getting schema for element : ${elementName}`);
            utility.checkSessionExpired(response.data);
            await utility.setTimer(retryServerTimer);
            await this.getStationStatusSchema();
          }
        }
      } catch (ex) {
        log.error(`Exception in getting schema for element : ${elementName} ${ex}`);
        await utility.setTimer(retryServerTimer);
        await this.getStationStatusSchema();
      }
    },
    /**
     * This method update the substation information when update event triggered
     * @param {Object} stationinfo
     */
    updateStation(stationinfo) {
      substation = stationinfo;
      lineid = substation[substationTags.LINEID_TAG];
      sublineid = substation[substationTags.SUBLINEID_TAG];
      sublinename = substation[substationTags.SUBLINENAME_TAG];
      substationname = substation[substationTags.NAME_TAG];
      substationid = substation[substationTags.SUBSTATIONID_TAG];
      stationname = substation[substationTags.STATIONNAME_TAG];
    },
    /**
     * 2 - Stop
     * 1 - Run
     */
    processStationData(data) {
      data = utility.cloneDeep(data);
      const now = data.timestamp;
      if (this.startup) {
        log.error('Init Station Status');
        stationstatus = data[staticTags.STATIONSTATUS_TAG];
        if (data[staticTags.STATIONSTATUS_TAG] == 2) {
          this.downtimestartflag = true;
        } else {
          this.downtimestartflag = false;
        }
        this.startup = false;
      }
      if (data[staticTags.STATIONSTATUS_TAG] && data[staticTags.STATIONSTATUS_TAG] != stationstatus) {
        stationstatus = data[staticTags.STATIONSTATUS_TAG];
        this.toggleStatus(data, now);
      }
      if (this.downtimestartflag && data[staticTags.STATIONSTATUS_TAG] === 2) {
        const currentShift = businessHours.getCurrentShiftRecord(now);
        const changeRecord = this.checkShiftChange(currentShift);
        if (changeRecord.isChange && (changeRecord.type == 'shift' || changeRecord.type == 'break')) {
          this.toggleStatus(data, now);
        }
      }
    },
    /**
     * This method end the old stationstatus record and write the new stationstatus record in ShopWorx database
     * @param {Object} plcdata
     */
    async toggleStatus(data, now) {
      // Upload to MES
      await this.writeRecordInMES(data, now);
      await this.endStationStatus(data, now);
      await this.startStationStatus(data, now);
    },
    async writeRecordInMES(data, now) {
      let erpcode = substation[substationTags.ERPCODE_TAG];
      const body = [{
        "work_center": erpcode,
        "state": data[staticTags.STATIONSTATUS_TAG].toString(),
        "start_time": moment(now).format('YYYYMMDDHHmmssSSS'),
      }];
      const response = await InterfaceService.commitState(body);
      if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        if (response.data.returncode === '0') {
          log.error(`Station Status Commit Successfully`);
        }
        else {
          log.error(JSON.stringify(response.data));
          log.error(`Station Status Commit error`);
          await utility.setTimer(5);
          this.writeRecordInMES(data, now);
        }
      } else {
        log.error(JSON.stringify(response));
        log.error(`Station Status Commit error`);
        await utility.setTimer(5);
        this.writeRecordInMES(data, now);
      }
    },
    checkShiftChange: function (runningShift) {
      try {
        if (!this.currentShiftType) {
          this.currentShiftName = runningShift.name;
          this.currentShiftType = runningShift.type;
          this.currentDate = runningShift.shiftdate;
          this.currentBusinessHour = runningShift.businessHour;
        }
        let currentShift = {
          isChange: false
        };
        // check date changed or not
        if (this.currentDate !== runningShift.shiftdate) {
          log.info('Shift Day Changed from ', this.currentDate, '  to ', runningShift.shiftdate);
          this.currentDate = runningShift.shiftdate;
          this.currentShiftType = runningShift.type;
          this.currentShiftName = runningShift.name;
          this.currentBusinessHour = runningShift.businessHour;
          currentShift = runningShift;
          currentShift.isChange = true;
        }
        // check type changed or not
        if (this.currentShiftType !== runningShift.type) {
          log.info('Shift Type Changed from ', this.currentShiftType, '  to ', runningShift.type);
          this.currentDate = runningShift.shiftdate;
          this.currentShiftType = runningShift.type;
          this.currentShiftName = runningShift.name;
          this.currentBusinessHour = runningShift.businessHour;
          currentShift = runningShift;
          currentShift.isChange = true;
        }
        // check shift changed or not
        if (this.currentShiftName !== runningShift.name) {
          log.info('Shift Changed from ', this.currentShiftName, '  to ', runningShift.name);
          this.currentDate = runningShift.shiftdate;
          this.currentShiftType = runningShift.type;
          this.currentShiftName = runningShift.name;
          this.currentBusinessHour = runningShift.businessHour;
          currentShift = runningShift;
          currentShift.isChange = true;
        }
        // check hour changed or not
        if (this.currentBusinessHour != runningShift.businessHour) {
          log.info('**********Hour Changed from ', this.currentBusinessHour, '  to ', runningShift.businessHour);
          this.currentDate = runningShift.shiftdate;
          this.currentShiftType = runningShift.type;
          this.currentShiftName = runningShift.name;
          this.currentBusinessHour = runningShift.businessHour;
          currentShift = runningShift;
          currentShift.isChange = true;
        }
        return currentShift;
      } catch (ex) {
        log.error('Exception in checking shift change', ex);
        return { isChange: false };
      }
    },
    /**
         * Calculate downtime based on downtime start and downtime end
         * If machines are down from 2 days and server shutdown on same time
         * When E.A start need to calculate in between downtimes and create downtime based on shift, breaktime
         *
         * @param {Long} starttime
         * @param {Long} endtime
         * @param {Object} currentDTObj
         * @param {Array} shiftObj
         * @param {Int} offset
         */
    manageSplitDowntime(starttime, endtime, plcdata, currentDTObj, shiftObj, offset) {
      if (starttime < endtime) {
        // businesshours record for starttime
        const currentShift = businessHours.getCurrentShiftRecord(starttime);
        const businessHourObjForStartime = businessHours.getBusinessHourForTimestamp(starttime);
        const currentDTEndtime = Math.min(businessHourObjForStartime.businessHourEndtime, currentShift.endtimestamp, endtime);
        let obj = utility.cloneDeep(currentDTObj);
        delete obj._id;
        delete obj.createdTimestamp;
        delete obj.modifiedTimestamp;
        delete obj.questions;
        obj.substationid = substationid;
        obj.substationname = substationname;
        obj.actualdowntimestart = currentDTObj.actualdowntimestart;
        obj.state = 'Completed';
        obj.timestamp = starttime;
        obj.starttime = starttime;
        obj.starttimestr = moment(starttime).format('DD-MM-YYYY HH:mm:ss');
        obj.starttimedate = moment(starttime).format('DD-MM-YYYY:HH:mm:ss');
        obj.endtime = currentDTEndtime;
        obj.endtimestr = moment(currentDTEndtime).format('DD-MM-YYYY HH:mm:ss');
        obj.endtimedate = moment(currentDTEndtime).format('DD-MM-YYYY:HH:mm:ss');
        obj.assetid = substation.assetid;
        const downtimeInMs = currentDTEndtime - starttime;
        obj.downtimeinms = downtimeInMs;
        obj.downtime = Math.floor(downtimeInMs / 1000);
        // check break or not
        if (currentShift.type === 'break') {
          obj.downtimereason = currentShift['name'];
        }
        // check holiday or not
        const holiday = businessHolidays.checkHoliday(starttime);
        if (holiday && holiday['name']) {
          obj.downtimereason = holiday['name'];
        }
        if (offset === 0) {
          plcdata.endtime = currentDTEndtime;
        } else if (obj.downtime > 0) {
          shiftObj.push(obj);
        }

        if (currentDTEndtime != endtime) {
          // If not last downtime
          this.manageSplitDowntime(currentDTEndtime, endtime, plcdata, currentDTObj, shiftObj, 1);
        }
      }
    },
    async startStationStatus(plcdata, now) {
      const elementName = "stationstatus";
      plcdata = utility.cloneDeep(plcdata);

      // const ngreason = this.ngreasonList.filter(item => item.id == plcdata[staticTags.NGREASON_TAG]);
      // let ngreasondescription = '';
      // if (ngreason.length > 0) {
      //   // use only update API
      //   ngreasondescription = ngreason[0].name;
      // }
      const currentshift = businessHours.getCurrentShiftRecord(now);
      delete currentshift._id;
      // add new record
      let payload = {
        ...currentshift,
        state: 'In Progress',
        starttime: Number(now),
        starttimestr: moment(Number(now)).format('DD-MM-YYYY HH:mm:ss'),
        starttimedate: moment(Number(now)).format('DD-MM-YYYY:HH:mm:ss'),
        assetid: substation.assetid,
        substationid: substationid,
        substationname: substationname || '',
        // sublinename: sublinename || '',
        status: plcdata[staticTags.STATIONSTATUS_TAG],
        // ngreason: plcdata[staticTags.STATIONSTATUS_TAG] == 2 ? plcdata[staticTags.NGREASON_TAG] : 0,
        endtime: 0,
        //ngreasondescription: plcdata[staticTags.STATIONSTATUS_TAG] == 2 ? ngreasondescription : '',
      };
      // payload = utility.assignDataToSchema(payload, stationStatusSchema);
      payload.assetid = substation.assetid;
      const addrecord = await elementService.createElementRecord(elementName, payload);
      if (addrecord.status === utility.HTTP_STATUS_CODE.SUCCESS) {
        log.error(`Record add successfully in ShopWorx for statestatus ${JSON.stringify(addrecord.data)}`);
        if (plcdata[staticTags.STATIONSTATUS_TAG] == 2) {
          this.downtimestartflag = true;
        } else {
          this.downtimestartflag = false;
        }
      } else {
        log.error(`Error in add statestatus record in ShopWorx ${JSON.stringify(addrecord.data)}`);
        utility.checkSessionExpired(addrecord.data);
        await utility.setTimer(retryServerTimer);
        this.startStationStatus(plcdata, now);
      }
    },
    async endStationStatus(plcdata, now) {
      const elementName = "stationstatus";
      plcdata = utility.cloneDeep(plcdata);
      plcdata.endtime = now;
      try {
        let query = `query=${[stationstatusTags.SUBSTATIONID_TAG]}=="${substationid}"`;
        query += `%26%26${[stationstatusTags.STATE_TAG]}=="${qs.escape('In Progress')}"`;
        query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
        const oldrecord = await elementService.getElementRecords(elementName, query);
        let stationstatusrecord;
        if (oldrecord.status === utility.HTTP_STATUS_CODE.SUCCESS) {
          if (oldrecord.data && oldrecord.data.results && oldrecord.data.results.length > 0) {
            // use only update API
            stationstatusrecord = oldrecord.data.results[0];
          }
          if (stationstatusrecord) {
            let payload = {};
            let starttime = stationstatusrecord.starttime;
            let endtime = now;
            if (plcdata[staticTags.STATIONSTATUS_TAG] == 2 && stationstatusrecord.status != 1) {
              let shiftObj = [];
              this.manageSplitDowntime(starttime, endtime, plcdata, stationstatusrecord, shiftObj, 0);
              if (shiftObj.length > 0) {
                // createBulk Records with V2
                log.error(`Split Long Downtime to ${shiftObj.length} records`);
                log.error(`${JSON.stringify(shiftObj)}`);
                await this.createBulkRecords(shiftObj);
              }
              payload.downtime = Math.floor((plcdata.endtime - starttime) / 1000);
              payload.downtimeinms = plcdata.endtime - starttime;
            }

            log.trace(`Payload ${JSON.stringify(payload)}`);
            let oldrecordid = stationstatusrecord._id;
            if (oldrecordid) {
              payload.state = 'Completed';
              payload.endtime = Number(plcdata.endtime);
              payload.endtimestr = moment(plcdata.endtime).format('DD-MM-YYYY:HH:mm:ss');
              payload.endtimedate = moment(plcdata.endtime).format('DD-MM-YYYY:HH:mm:ss');
              if (stationstatusrecord.status == 2) {
                payload.downtime = Math.floor((plcdata.endtime - starttime) / 1000);
                payload.downtimeinms = plcdata.endtime - starttime;
              }
              payload.assetid = substation.assetid;
              const updaterecord = await elementService.updateElementRecordById(elementName, payload, oldrecordid);
              if (updaterecord.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                log.error(`Successfully update statestatus in ShopWorx ${JSON.stringify(updaterecord.data)}`);
              } else {
                log.error(`Error in update statestatus in ShopWorx ${JSON.stringify(updaterecord.data)}`);
                utility.checkSessionExpired(updaterecord.data);
                await utility.setTimer(retryServerTimer);
                await this.endStationStatus(plcdata, now);
              }
            }
          }
        } else {
          log.error(`Error in getting data from elementName : ${elementName} ${JSON.stringify(oldrecord.data)}`);
          utility.checkSessionExpired(oldrecord.data);
          await utility.setTimer(retryServerTimer);
          await this.endStationStatus(plcdata, now);
        }
      } catch (error) {
        log.error(`Exception in End Downtime ${error}`);
        await utility.setTimer(retryServerTimer);
        await this.endStationStatus(plcdata, now);
      }
    },
    async createBulkRecords(payload) {
      const elementName = "stationstatus";
      try {
        const response = await elementService.createElementMultipleRecords(elementName, payload);
        const { status, data } = response;
        log.trace(`Create bulk Downtime record Payload ${JSON.stringify(payload)}`);
        if (status == utility.HTTP_STATUS_CODE.SUCCESS && data && data.results) {
          log.error(`create bulk downtime records saved successfully ${JSON.stringify(data.results)}`);
        } else {
          log.error(`Error in creating bulk downtime records  statusCode ${status} response ${JSON.stringify(data)}`);
          utility.checkSessionExpired(data);
          // wait for execute next function call
          await utility.setTimer(retryServerTimer);
          log.error(`-------- Retry --------`);
          await this.createBulkRecords(payload);
        }
      } catch (ex) {
        log.error(`Exception in creating bulk downtime records ${ex}`);
        // wait for execute next function call
        await utility.setTimer(retryServerTimer);
        log.error(`-------- Retry --------`);
        await this.createBulkRecords(payload);
      }
    },
  };
}
