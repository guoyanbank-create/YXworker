/** P2 路由占位（backend-p2 实现）。挂载在 /api 下。 */
import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';

export interface RouterDeps {
  db: Db;
  config: AppConfig;
}

export function createImpactRouter(_deps: RouterDeps): Router {
  return Router();
}
