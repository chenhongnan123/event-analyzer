const apiService = require('./api.service');
const ApiService = apiService.ApiService;

class UserService {
  constructor() {
    this.request = ApiService;
  }

  getMe() {
    return this.request.get('/server/users/mydetails');
  }

  getSolution() {
    return this.request.get('/server/solution');
  }
  
  isUsernameAvailable(username) {
    return this.request.get(`/server/users/isUsernameAvailable/${username}`);
  }

  getUserById(id) {
    return this.request.get(`/server/users/${id}`);
  }

  updateUser(payload) {
    return this.request.put('/server/users', payload);
  }

  updatePassword(payload) {
    return this.request.put('/server/users/updatepassword', payload);
  }

  inviteUsers(payload) {
    return this.request.post('server/users', payload);
  }
}
module.exports.UserService = new UserService();
