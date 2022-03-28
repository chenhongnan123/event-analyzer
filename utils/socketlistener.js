'use strict';
const nodePackage = require('../service/nodepackage.service');
const NodePackage = nodePackage.NodePackage;
const EventEmitter = NodePackage.EventEmitter;
EventEmitter.prototype._maxListeners = 1000;
const emitter = new EventEmitter.EventEmitter();
const bunyan = NodePackage.bunyan;
const socket = require('socket.io-client');
module.exports.socketlistener = socketlistener;
module.exports.emitter = emitter;
function socketlistener(config) {
    let log = bunyan.createLogger({ name: 'Socket Listener', level: config.logger.loglevel })
    let socketio = config.socketio;
    let server = config.server;
    return {
        init: function () {
            log.info(`${socketio.host} : ${socketio.port}`);
            let defaultSocket = socket(`${server.protocol}://${socketio.host}:${socketio.port}`);
            defaultSocket.on('connect', () => {
                log.info(`Default update_<elementName> Socket connected `)
            });
            defaultSocket.on('disconnect', () => {
                log.error(`Default update_<elementName> Socket disconnected `)
            });
            defaultSocket.on('update_businesshours', (data) => {
                emitter.emit('businesshours', data);
            });
            defaultSocket.on('update_businessholidays', (data) => {
                emitter.emit('businessholidays', data);
            });
            defaultSocket.on('update_recipe', (data) => {
                emitter.emit('recipe', data);
            });
            defaultSocket.on('update_order', (data) => {
                emitter.emit('order', data);
            });

            defaultSocket.on('update_substation', (data) => {
                emitter.emit('substation', data);
            });
            defaultSocket.on('update_parameters', (data) => {
                emitter.emit('parameters', data);
            });
            defaultSocket.on('update_inspect', (data) => {
                emitter.emit('inspect', data);
            });
            // call socketNamespace
            if (socketio.namespace) {
                this.socketNamespace();
            }
        },
        // swx namespace socket listener
        socketNamespace: function () {
            let namespace = socketio.namespace;
            let eventName = socketio.eventname;
            let socketNamespace = socket(`${server.protocol}://${socketio.host}:${socketio.port}/${namespace}`);
            socketNamespace.on('connect', () => {
                emitter.emit('connect', 'connect');
                log.info(`SWX analyzer_<eventname> Socket connected `)
            });
            socketNamespace.on('disconnect', () => {
                log.error(`SWX analyzer_<eventname> Socket disconnected `)
            });
            this.socketNamespace = socketNamespace;
            socketNamespace.on(`${namespace}_${eventName}`, (data) => {
                emitter.emit(`${eventName}`, data);
            });
            // PLC Error
            socketNamespace.on(`${namespace}_${eventName}plcerror`, (error) => {
                emitter.emit(`${eventName}plcerror`, error);
            });

            socketNamespace.on(`${namespace}_recipedownload`, (data) => {
                emitter.emit('recipedownload', data);
            });

            socketNamespace.on(`${namespace}_recipeupload`, (data) => {
                emitter.emit('recipeupload', data);
            });

            socketNamespace.on(`${namespace}_parameterupload`, (data) => {
                emitter.emit('parameterupload', data);
            });
        }
    }
}