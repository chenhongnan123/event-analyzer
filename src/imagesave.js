'use strict';
module.exports.imageSave = imageSave;
const elementService = require('../service/element.service.js').ElementService;
const nodePackage = require('../service/nodepackage.service');
const apiService = require('../service/api.service');
const NodePackage = nodePackage.NodePackage;
const bunyan = NodePackage.bunyan;
const fs = NodePackage.fs;
const path = NodePackage.path;
const Client = NodePackage.Client;
const moment = NodePackage.moment;
const FormData = require('form-data');
const ApiService = apiService.ApiService;
const axios = NodePackage.axios;
function imageSave(config, substation, utility, tags, MESSAGESCODE, emitter) {
  const server = config.server;
  const elements = config.elements;
  const substationTags = tags.substationtags;
  const staticTags = tags.statictags;
  let previousvalidatebit;
  let lineid = substation[substationTags.LINEID_TAG];
  let sublineid = substation[substationTags.SUBLINEID_TAG];
  let stationid = substation[substationTags.STATIONID_TAG];
  let substationid = substation[substationTags.SUBSTATIONID_TAG];
  const log = bunyan.createLogger({ name: `ImageSave_${substationid}`, level: config.logger.loglevel })
  return {
      
    processStationData(data) {

      data = utility.cloneDeep(data);

      if (!data[staticTags.CHECKOUTTRIGGER_TAG]) {
        previousvalidatebit = 0;
      }

      if (previousvalidatebit === 0 && data[staticTags.CHECKOUTTRIGGER_TAG] === 1) {
        previousvalidatebit = 1;
        this.readImage(data)
      }
    },
    readImage(data) { 
      log.error(`Read File`);
      const mainid = data[staticTags.MAINID_TAG];
      const ftpserver = JSON.parse(substation.jsondata).ftpserver || {};
      const imagefilepath = JSON.parse(substation.jsondata).imagefilepath;
      const that = this;
      const c = new Client();
      try {
        c.on('ready', () => {
          let source = ftpserver.source
          const url = `${imagefilepath}/${moment().format("YYYYMMDD")}/${mainid.split("/").join('')}`;
          that.mkdirs(url, (err) => {
            if (err) {
              log.error(`Error in creating directory ${url} ${err}`)
              throw err;
            }
            c.list(source, (err, list) => {
              if (err) {
                log.error(err.message)
              } else {
                if (!list || list.length < 1) {
                  c.end()
                  return;
                }
                let tempList = [...list]
                let promises = tempList.map((item, index) => {
                  return new Promise((resolve, reject) => {
                    if (item.name.split('.')[1] != "jpg") {
                      resolve()
                    } else {
                      let filename = source + "//" + item.name;
                      c.get(filename, (err, stream) => {
                        if (err) {
                          log.error(err.message);
                          reject(err);
                        } else {
                          
                          const name = `${url}/${mainid.split("/").join('')}_${moment().format("YYYYMMDD")}_${moment().format("HHmmss")}_${index}.jpg`;
                          stream.once('close', () => {
                            c.delete(filename, (err) => {
                              resolve()
                            })
                            log.info(`File ${filename} Downloaded.`)
                            if(ftpserver.savetodb) {
                    		    that.storeImage(fs.createReadStream(name), `${mainid.split("/").join('')}${index}`,mainid);
			                }
                          });
                          stream.pipe(fs.createWriteStream(name))
                          log.error(`${url}/${item.name}`);
                        }
                      })

                    }
                  })
                })
                Promise.all(promises).then((value) => {
                  c.end()
                }).catch(err => {
                  log.error(err)
                })
              }

            })
          });
        })
      } catch (ex) {
        log.error(`Exception in creating directory`);
      }

      c.connect({
        host: ftpserver.host,
        port: ftpserver.port,
        user: ftpserver.user,
        password: ftpserver.password
      });
    },

    mkdirs(dirname, callback) {
      const that = this;
      fs.exists(dirname, (exists) => {
        if (exists) {
          callback();
        } else {
          //console.log(path.dirname(dirname));  
          that.mkdirs(path.dirname(dirname), () => {
            fs.mkdir(dirname, callback);
          });
        }
      });
    },
    async storeImage(stream, name, mainid) {
        const form = new FormData();
        form.append('file', stream, { contentType: 'multipart/form-data' });
        const formHeaders = form.getHeaders();
        const elementName = elements.productionimage;
        const url = `${server.protocol}://${server.host}:${server.port}/server/uploadfile/image/${name}?elementName=${elementName}&extension=jpeg`;
        const config = {
            headers: {
                ...formHeaders,
                "sessionId": ApiService.instance.defaults.headers.common.sessionId,
                "cookie": ApiService.instance.defaults.headers.cookie
            }
        }
        try{
            const response = await axios.post(url, form, config)
            if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                log.error(`Record saved successfully in ShopWorx for product image ${JSON.stringify(response.data)}`);
                let payload = {
                  "mainid": mainid,
                  "image": `/downloadfile/image/${name}/jpeg`,
                  "timestamp": moment().valueOf(),
                  "assetid": substation.assetid,
                  "lineid": lineid,
                  "sublineid": sublineid,
                  "stationid": stationid,
                  "substationid": substationid,
                };
                this.writeImageRecordInSWX(payload)
            } else {
                log.error(`Error in writing product image data in ShopWorx ${JSON.stringify(response.data)}`);
                utility.checkSessionExpired(response.data);
            }
        } catch(ex) {
            log.error(`Exception in writing product image data in ShopWorx ${ex}`);
        }
    },

    /**
    * This method write the base64 image  in ShopWorx database
    * @param {Object} plcdata 
    */
    async writeImageRecordInSWX(payload) {
        log.trace(`product image info Payload ${JSON.stringify(payload)}`);
        const elementName = elements.productionimageinfo;
        try {
            const response = await elementService.createElementRecord(elementName, payload)
            if (response.status === utility.HTTP_STATUS_CODE.SUCCESS) {
                log.error(`Record saved successfully in ShopWorx for product image info ${JSON.stringify(response.data)}`);
            } else {
                log.error(`Error in writing product image info data in ShopWorx ${JSON.stringify(response.data)}`);
                utility.checkSessionExpired(response.data);
            }
        } catch (ex) {
            log.error(`Exception in writing product image info data in ShopWorx elementName : ${elementName} Exception ${ex}`);
        }
    }
  }
}