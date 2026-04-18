export type Framework = 'graphene' | 'strawberry' | 'ariadne' | 'graphql-schema';

export interface FieldArgInfo {
  name: string;
  type: string;
  required: boolean;
}

export interface FieldInfo {
  name: string;
  fieldType: string;
  resolvedType?: string;
  args?: FieldArgInfo[];
  filePath: string;
  lineNumber: number;
  /**
   * Set by resolveInheritedFields to the name of the class that **declares**
   * the field. Undefined for fields declared directly on the owning class.
   * Drives: (1) field-index routing to the true owner, (2) inspector "origin"
   * display, (3) click-to-source navigation.
   */
  definedIn?: string;
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
