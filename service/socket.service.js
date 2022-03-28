const nodePackage = require('./nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const axios = NodePackage.axios;
const socketio = NodePackage.socketio;
class SocketService {
  constructor() {
    this.instance = axios.create({
      baseURL: ``,
    });
  }

  request(method, url, data = {}, config = {}) {
    return this.instance({
      method,
      url,
      data,
      config,
    });
  }

  post(url, data, config = {}) {
    return this.request('POST', url, data, config);
  }
}

module.exports.SocketService = new SocketService();