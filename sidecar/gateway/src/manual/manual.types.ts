/**
 * a3 网关接口手册与用法说明类型定义
 */

export interface ApiParamDoc {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description: string;
  example?: unknown;
}

export interface ApiFieldDoc {
  name: string;
  type: string;
  description: string;
}

export interface ApiErrorResponseDoc {
  statusCode: number;
  description: string;
}

export interface ApiInputsDoc {
  headers?: ApiParamDoc[];
  params?: ApiParamDoc[];
  query?: ApiParamDoc[];
  body?: ApiParamDoc[];
}

export interface ApiOutputsDoc {
  statusCode: number;
  description: string;
  fields: ApiFieldDoc[];
  example?: Record<string, unknown> | unknown[];
  errorResponses?: ApiErrorResponseDoc[];
}

export interface ApiManualItem {
  index: number;
  key: string;
  name: string;
  category: string;
  method: string;
  path: string;
  authRequired: boolean;
  description: string;
  inputs: ApiInputsDoc;
  outputs: ApiOutputsDoc;
  curlExample?: string;
}

export interface ApiCatalogEntry {
  index: number;
  key: string;
  method: string;
  path: string;
  category: string;
  summary: string;
  authRequired: boolean;
  detailUrl: string;
}

export interface ApiCatalogResponse {
  title: string;
  version: string;
  total: number;
  usageTip: string;
  catalog: ApiCatalogEntry[];
}
