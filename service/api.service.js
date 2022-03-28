const nodePackage = require('./nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const axios = NodePackage.axios;
const server = NodePackage.server;
class ApiService {
  constructor() {
    this.instance = axios.create({
      baseURL: `${server.protocol}://${server.host}:${server.port}`,
    });
  }
  
  setTimeout(timeout){
    this.instance.defaults.timeout = (timeout || 5) * 1000
  }
  
  setDefaultHeader(loginType) {
    this.instance.defaults.headers.common.loginType = loginType;
  }

  setHeader(session) {
    this.instance.defaults.headers.common.sessionId = session;
    this.instance.defaults.headers.cookie=`JSESSIONID=${session}; sessionId=${session}`;
  }

  removeHeader() {
    this.instance.defaults.headers.common = {}
  }

  request(method, url, data = {}, config = {}) {
    return this.instance({
      method,
      url,
      data,
      config,
    });
  }

  get(url, config = {}) {
    return this.request('GET', url, {}, config);
  }

  post(url, data, config = {}) {
    return this.request('POST', url, data, config);
  }

  put(url, data, config = {}) {
    return this.request('PUT', url, data, config);
  }

  patch(url, data, config = {}) {
    return this.request('PATCH', url, data, config);
  }

  delete(url, config = {}) {
    return this.request('DELETE', url, {}, config);
  }
}

module.exports.ApiService = new ApiService();