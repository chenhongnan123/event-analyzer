"use strict";
module.exports.virtualmainid = virtualmainid;
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const elementService = require('../service/element.service.js').ElementService;
const moment = NodePackage.moment;
// LingZhong
const ID = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

function virtualmainid(config, substation, utility, tags, MESSAGESCODE) {
    const staticTags = tags.statictags;
    const indexnumberTags = tags.indexnumberTags;
    const mainidbindcarrieridTags = tags.mainidbindcarrieridTags;

    const elements = config.elements;
    const mainidConfig = substation.jsondata.mainid || {};

    return {
        mainid: '',
        /**
         * This method get the virtualmainid indexnumber
         * @param {Function} resolve - Promise resolve
         */
        async getIndexNumber(resolve, type) {
            const elementName = elements.indexnumber || 'indexnumber'
            let indexnumber;
            try {
                let query = `query=${[indexnumberTags.DATE_TAG]}=="${moment().format("YYYYMMDD")}"`;
                query += `%26%26${[indexnumberTags.TYPE_TAG]}=="${type}"`;
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                const response = await elementService.getElementRecords(
                    elementName,
                    query
                );
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    let payload = {
                        [indexnumberTags.DATE_TAG]: moment().format("YYYYMMDD"),
                        [indexnumberTags.TYPE_TAG]: type,
                    }
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        const record = response.data.results[0]
                        indexnumber = record[indexnumberTags.NUMBER_TAG]
                        payload[indexnumberTags.NUMBER_TAG] = indexnumber + 1
                    } else {
                        indexnumber = 1
                        payload[indexnumberTags.NUMBER_TAG] = 2
                    }
                    payload.assetid = substation.assetid;
                    let putquery = `query=${[indexnumberTags.DATE_TAG]}=="${moment().format("YYYYMMDD")}"`;
                    const putrecord = await elementService.upsertElementRecordsByQuery(elementName, payload, putquery);
                    putquery += `%26%26${[indexnumberTags.TYPE_TAG]}=="${type}"`;
                    if (putrecord.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                        resolve({
                            state: true,
                            data: indexnumber
                        })
                    } else {
                        utility.checkSessionExpired(putrecord.data);
                        resolve({
                            state: false,
                            msg: `Error in putting data from elementName : ${elementName} ${JSON.stringify(putrecord.data)}`
                        })
                    }
                } else {
                    utility.checkSessionExpired(response.data);
                    resolve({
                        state: false,
                        msg: `Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`
                    })
                }
            } catch (ex) {
                const messageObject = ex.response ? ex.response.data : ex;
                resolve({
                    state: false,
                    msg: `Exception to fetch data for element : ${elementName},Error: ${messageObject}`
                })
            }
        },
        /**
         * This method bind the mainid with carrierid
         * @param {String} mainid
         * @param {String} carrierid
         * @param {Function} Resolve - Promise resolve
         */
        async bindMainIdWithCarrierID(mainid, carrierid, Resolve) {
            const elementName = elements.mainidbindcarrierid || 'mainidbindcarrierid'
            const carrierStatus = await new Promise((resolve) => {
                this.checkCarrierStatus(carrierid, resolve)
            });
            if (carrierStatus.state) {
                try {
                    const payload = {
                        [staticTags.MAINID_TAG]: mainid,
                        [mainidbindcarrieridTags.CARRIERID_TAG]: carrierid,
                        [mainidbindcarrieridTags.STATUS_TAG]: 1
                    }
                    payload.assetid = substation.assetid;
                    let putquery = `query=${[mainidbindcarrieridTags.STATUS_TAG]}==1`;
                    putquery += `%26%26${[mainidbindcarrieridTags.CARRIERID_TAG]}=="${carrierid}"`
                    const response = await elementService.upsertElementRecordsByQuery(elementName, payload, putquery);
                    if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                        Resolve({
                            state: true
                        })
                    } else {
                        utility.checkSessionExpired(response.data);

                        Resolve({
                            state: false,
                            msg: `Error in putting data from elementName : ${elementName} ${JSON.stringify(response.data)}`
                        })
                    }

                } catch (ex) {
                    const messageObject = ex.response ? ex.response.data : ex
                    Resolve({
                        state: false,
                        msg: `Exception to fetch data for element : ${elementName},Error: ${messageObject}`
                    })
                }
            } else {
                Resolve({
                    state: false,
                    msg: carrierStatus.msg
                })
            }

        },
        /**
         * This method generate the virtualmainid
         * @param {Function} Resolve - Promise resolve
         */
        async generateVirtualMainId(Resolve, orderdata) {
            const elementName = elements.labelrule || "labelrule";
            if (this.mainid) {
                Resolve({
                    state: true,
                    data: this.mainid,
                });
            } else {
              const pn = orderdata.part_code || 'P1234567';
              const version = orderdata.versionno || 'AA';
              const suppliercode = orderdata.supperno || 'A12345';
              const supplierinfo = orderdata.work_info || '0001X1';
              const indexnumber = await new Promise((resolve) => {
                  this.getIndexNumber(resolve, orderdata.productname)
              })
              if (indexnumber.state) {
                  const mainid = `[>16${pn}V${version}D${moment().format("DDD").padStart(3, '0')}${moment().format("YY")}${suppliercode.padStart(6, '0')}S${supplierinfo}N${String(indexnumber.data).padStart(5, '0')}`;
                  if (mainid.length == 40) {
                      Resolve({
                          state: true,
                          data: mainid
                      })
                  } else {
                      Resolve({
                          state: false,
                          data: `Mainid length is ${mainid.length} not equal to 40`
                      })
                  }
              } else {
                  Resolve({
                      state: false,
                      msg: indexnumber.msg
                  })
              }
            }
        },
        /**
        * This method check the mainid in swx with carrierid
        * @param {String} carrierid
        * @param {Function} resolve - Promise resolve
        */
        async checkCarrierStatus(carrierid, resolve) {
            const elementName = elements.mainidbindcarrierid || 'mainidbindcarrierid'
            try {
                let query = `query=${[mainidbindcarrieridTags.STATUS_TAG]}==1`;
                query += `%26%26${[mainidbindcarrieridTags.CARRIERID_TAG]}=="${carrierid}"`
                const response = await elementService.getElementRecords(elementName, query);
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        resolve({
                            state: false,
                            msg: `CarrierId: ${carrierid} has not unbinded!`
                        })
                    } else {
                        resolve({
                            state: true
                        })
                    }
                } else {
                    utility.checkSessionExpired(response.data);
                    resolve({
                        state: false,
                        msg: `Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`
                    })
                }
            } catch (ex) {
                const messageObject = ex.response ? ex.response.data : ex
                resolve({
                    state: false,
                    msg: `Exception to fetch data for element : ${elementName},Error: ${messageObject}`
                })
            }
        },
        /**
         * This method check the mainid in swx with carrierid
         * @param {String} carrierid
         * @param {Function} resolve - Promise resolve
         */
        async checkMainIdByCarrierId(carrierid, resolve) {
            const elementName = elements.mainidbindcarrierid || 'mainidbindcarrierid';
            try {
                let query = `query=${[mainidbindcarrieridTags.STATUS_TAG]}==1`;
                query += `%26%26${[mainidbindcarrieridTags.CARRIERID_TAG]}=="${carrierid}"`
                query += `&sortquery=createdTimestamp==-1&pagenumber=1&pagesize=1`;
                const response = await elementService.getElementRecords(elementName, query)
                if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        const record = response.data.results[0]
                        resolve({
                            state: true,
                            data: record[mainidbindcarrieridTags.MAINID_TAG]
                        })
                    } else {
                        resolve({
                            state: false,
                            msg: `Missing Mainid for Carrierid in SWX: ${carrierid}`,
                        })
                    }
                } else {
                    utility.checkSessionExpired(response.data);
                    resolve({
                        state: false,
                        msg: `Error in getting data from elementName : ${elementName} ${JSON.stringify(response.data)}`
                    })
                }
            } catch (ex) {
                const messageObject = ex.response ? ex.response.data : ex
                resolve({
                    state: false,
                    msg: `Exception to fetch data for element : ${elementName},Error: ${messageObject}`
                })
            }
        },
        async unbindMainIdWithCarrierId(mainid, carrierid, resolve) {
            // unbind carrierid with mainid
            let query = `query=${[mainidbindcarrieridTags.CARRIERID_TAG]}=="${carrierid}"`;
            query += `%26%26${[mainidbindcarrieridTags.MAINID_TAG]}=="${mainid}"`;
            query += `%26%26${[mainidbindcarrieridTags.STATUS_TAG]}==1`;
            let payload = {
                [mainidbindcarrieridTags.STATUS_TAG]: 0
            }
            payload.assetid = substation.assetid;
            const unbind = await elementService.updateElementRecordsByQuery(elements.mainidbindcarrierid || 'mainidbindcarrierid', payload, query)
            if (unbind.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                resolve({
                    state: true
                })
            } else {
                // check authentication
                utility.checkSessionExpired(unbind.data);
                resolve({
                    state: false,
                    msg: `Error in unbind carrierid with mainid in ShopWorx ${JSON.stringify(unbind.data)}`
                })
            }

        },
    }
}
