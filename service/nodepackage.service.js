const bunyan = require('bunyan');
const axios = require('axios');
const qs = require('querystring');
const kafkanode = require('kafka-node');
const EventEmitter = require('events');
const socket = require('socket.io-client');
const datefns = require('date-fns');
const fs = require("fs");  
const path = require("path");  
const Client = require('ftp');
const moment = require('moment');

class NodePackage {
  constructor() {
    this.bunyan = bunyan;
    this.axios = axios;
    this.qs = qs;
    this.kafkaNode = kafkanode;
    this.EventEmitter = EventEmitter;
    this.socket = socket;
    this.datefns = datefns;
    this.fs = fs;
    this.path = path;
    this.Client = Client;
    this.moment = moment;
  }
}
module.exports.NodePackage = new NodePackage();