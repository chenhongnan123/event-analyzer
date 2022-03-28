const apiService = require('./api.service');
const ApiService = apiService.ApiService;

class ElementService {
  constructor() {
    this.request = ApiService;
  }

  createElement(data) {
    return this.request.post('/server/elements', data);
  }

  getElement(elementName) {
    return this.request.get(`/server/elements/${elementName}`);
  }

  getElementRecords(elementName, query) {
    let url = `/server/elements/${elementName}/records`;
    if(query){
      url += `?${query}`
    }
    return this.request.get(`${url}`);
  }

  getElementRecordByPost(elementName, data, query){
    let url = `/server/elements/${elementName}/records`;
    if(query){
      url += `?${query}`
    }
    return this.request.post(`${url}`, data);
  }

  createElementRecord(elementName, data) {
    return this.request.post(`/server/elements/${elementName}/records`,data);
  }

  createElementRecordV2(elementName, data) {
    return this.request.post(`/server/elements/${elementName}/records/v2`,data);
  }

  createElementMultipleRecords(elementName, data) {
    return this.request.post(`/server/elements/${elementName}/createbulkrecords`,data);
  }

  createElementMultipleRecordsV2(elementName, data) {
    return this.request.post(`/server/elements/${elementName}/createbulkrecords/v2`,data);
  }

  updateElementMultipleRecords(elementName, data) {
    return this.request.put(`/server/elements/${elementName}/updatemultiplerecords`,data);
  }

  updateElementRecordById(elementName, data, id) {
    return this.request.put(`/server/elements/${elementName}/records/${id}`, data);
  }

  getMultipleElementsQueryRecords(data) {
    return this.request.post(`/server/elements/records`, data);
  }

  updateElementRecordsByQuery(elementName, data, query) {
    let url = `/server/elements/${elementName}/records`;
    if(query){
      url += `?${query}`;
    }
    return this.request.put(url, data);
  }

  upsertElementRecordsByQuery(elementName, data, query) {
    let url = `/server/elements/${elementName}/records/createorupdate`;
    if(query){
      url += `?${query}`;
    }
    return this.request.put(url, data);
  }
}

module.exports.ElementService = new ElementService();
