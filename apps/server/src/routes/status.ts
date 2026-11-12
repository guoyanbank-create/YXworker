/** 路由占位：由对应模块负责人实现。挂载在 /api 下。 */
import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

export function createStatusRouter(_deps: RouterDeps): Router {
  return Router();
}
