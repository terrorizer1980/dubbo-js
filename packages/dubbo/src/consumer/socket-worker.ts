/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import debug from 'debug';
import net from 'net';
import {noop} from '../common/util';
import DecodeBuffer from '../serialization/decode-buffer';
import {decodeDubboResponse} from '../serialization/decode-hessian2';
import {DubboRequestEncoder} from '../serialization/encode-hessian2';
import HeartBeat from '../serialization/heartbeat';
import {IObservable, ISocketSubscriber} from '../types';
import Context from './context';
import {SOCKET_STATUS} from './socket-status';
import statistics from './statistics';

let pid = 0;
const RETRY_NUM = 20;
const RETRY_TIME = 3000;
const log = debug('dubbo:socket-worker');

/**
 * 具体处理tcp底层通信的模块
 * 1 负责socket的创建和通信
 * 2.负责dubbo的序列化和反序列化
 * 3.socket断开自动重试
 */
export default class SocketWorker implements IObservable<ISocketSubscriber> {
  private constructor(host: string, port: number) {
    this.pid = ++pid;
    //statistics info
    statistics['pid#' + this.pid] = 0;

    this.host = host;
    this.port = port;
    this._retry = RETRY_NUM;
    this._status = SOCKET_STATUS.PADDING;

    log('new SocketWorker#%d|> %s %s', pid, host + ':' + port, this._status);

    //init subscriber
    this._subscriber = {
      onConnect: noop,
      onData: noop,
      onClose: noop,
    };

    //init decodeBuffer
    this._decodeBuff = new DecodeBuffer().subscribe(
      this._onSubscribeDecodeBuff,
    );

    //init socket
    this._initSocket();
  }

  public readonly pid: number;
  public readonly host: string;
  public readonly port: number;

  private _retry: number;
  private _retryTimeoutId: NodeJS.Timer;
  private _heartBeatTimer: HeartBeat;
  private _socket: net.Socket;
  private _status: SOCKET_STATUS;
  private _decodeBuff: DecodeBuffer;
  private _subscriber: ISocketSubscriber;

  //==================================public method==========================

  /**
   * static factory method
   * @param url(host:port)
   */
  static from(url: string) {
    const [host, port] = url.split(':');
    return new SocketWorker(host, Number(port));
  }

  /**
   * send data to dubbo service
   * @param ctx dubbo context
   */
  write(ctx: Context) {
    log(`SocketWorker#${this.pid} =invoked=> ${ctx.requestId}`);
    statistics['pid#' + this.pid] = ++statistics['pid#' + this.pid];

    // update heartbeat lastWriteTimestamp
    this._heartBeatTimer.setWriteTimestamp();

    //current dubbo context record the pid
    //when current worker close, fail dubbo request
    ctx.pid = this.pid;
    const encoder = new DubboRequestEncoder(ctx);
    this._socket.write(encoder.encode());
  }

  get status() {
    return this._status;
  }

  /**
   * current status is whether avaliable or not
   */
  get isAvaliable() {
    return this._status === SOCKET_STATUS.CONNECTED;
  }

  /**
   * current status whether retry or not
   */
  get isRetry() {
    return this._status === SOCKET_STATUS.RETRY;
  }

  /**
   * reset retry number
   */
  resetRetry() {
    this._retry = RETRY_NUM;
    if (this._status === SOCKET_STATUS.CLOSED) {
      this._initSocket();
    }
  }

  /**
   * subscribe the socket worker events
   * @param subscriber
   */
  subscribe(subscriber: ISocketSubscriber) {
    this._subscriber = subscriber;
    return this;
  }

  //==========================private method================================
  private _initSocket() {
    log(`SocketWorker#${this.pid} =connecting=> ${this.host}:${this.port}`);

    if (this._socket) {
      this._socket.destroy();
    }

    this._socket = new net.Socket();
    this._socket.setNoDelay();
    this._socket
      .connect(
        this.port,
        this.host,
        this._onConnected,
      )
      .on('data', this._onData)
      .on('error', this._onError)
      .on('close', this._onClose);
  }

  private _onConnected = () => {
    log(`SocketWorker#${this.pid} <=connected=> ${this.host}:${this.port}`);

    //set current status
    this._status = SOCKET_STATUS.CONNECTED;

    //reset retry number
    this._retry = RETRY_NUM;
    this._heartBeatTimer = HeartBeat.from({
      label: `socket-worker:${this.pid}`,
      transport: this._socket,
      onTimeout: () => this._onClose(false),
    });

    //notifiy subscriber, the socketworker was connected successfully
    this._subscriber.onConnect({
      pid: this.pid,
      host: this.host,
      port: this.port,
    });
  };

  private _onData = data => {
    log(`SocketWorker#${this.pid}  =receive data=> ${this.host}:${this.port}`);
    this._decodeBuff.receive(data);
  };

  private _onError = (error: Error) => {
    log(
      `SocketWorker#${this.pid} <=occur error=> ${this.host}:${
        this.port
      } ${error}`,
    );
  };

  private _onClose = (hadError: boolean) => {
    log(
      `SocketWorker#${this.pid} <=closed=> ${this.host}:${
        this.port
      } hasError: ${hadError} retry: ${this._retry}`,
    );

    //clear buffer
    this._decodeBuff.clearBuffer();

    if (this._retry > 0) {
      //set current status
      this._status = SOCKET_STATUS.RETRY;
      //retry when delay RETRY_TIME
      clearTimeout(this._retryTimeoutId);
      this._retryTimeoutId = setTimeout(() => {
        this._retry--;
        this._initSocket();
      }, RETRY_TIME);
    } else {
      this._status = SOCKET_STATUS.CLOSED;
      this._socket.destroy();
      //set state closed and notified socket-pool
      this._subscriber.onClose({
        pid: this.pid,
        host: this.host,
        port: this.port,
      });
    }
  };

  private _onSubscribeDecodeBuff = (data: Buffer) => {
    if (HeartBeat.isHeartBeat(data)) {
      log(`SocketWorker#${this.pid} <=receive= heartbeat data.`);
      // apply heartbeat
      this._heartBeatTimer.emit();
    } else {
      const json = decodeDubboResponse(data);
      log(`SocketWorker#${this.pid} <=received=> dubbo result %O`, json);
      this._subscriber.onData(json);
    }
  };
}
