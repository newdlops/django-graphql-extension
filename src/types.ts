export type Framework = 'graphene' | 'strawberry' | 'ariadne' | 'graphql-schema';

export interface FieldInfo {
  name: string;
  fieldType: string;
  resolvedType?: string;
  filePath: string;
  lineNumber: number;
}

export interface ClassInfo {
  name: string;
  baseClasses: string[];
  framework: Framework;
  filePath: string;
  lineNumber: number;
  fields: FieldInfo[];
  kind: 'query' | 'mutation' | 'subscription' | 'type';
}

export interface SchemaInfo {
  name: string;
  filePath: string;
  queries: ClassInfo[];
  mutations: ClassInfo[];
  subscriptions: ClassInfo[];
  types: ClassInfo[];
}

export interface ProjectInfo {
  rootDir: string;
  frameworks: Framework[];
}
