import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectInfo, Framework } from '../types';
import { log } from '../logger';

export async function detectProjects(): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  const seenRoots = new Set<string>();

  // Strategy 1: Find Django settings.py with any GraphQL framework
  const settingsFiles = await vscode.workspace.findFiles(
    '**/settings.py',
    '{**/node_modules/**,**/.venv/**,**/venv/**,**/env/**,**/site-packages/**}'
  );

  for (const uri of settingsFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();

    const frameworks: Framework[] = [];

    if (/GRAPHENE\s*=\s*\{/.test(text) || /['"]graphene_django['"]/.test(text)) {
      frameworks.push('graphene');
    }
    if (/['"]strawberry_django['"]/.test(text) || /['"]strawberry\.django['"]/.test(text)) {
      frameworks.push('strawberry');
    }
    if (/['"]ariadne['"]/.test(text) || /['"]ariadne_django['"]/.test(text)) {
      frameworks.push('ariadne');
    }

    if (frameworks.length > 0) {
      const rootDir = await resolveProjectRoot(uri.fsPath);
      if (!seenRoots.has(rootDir)) {
        seenRoots.add(rootDir);
        projects.push({ rootDir, frameworks });
      } else {
        const existing = projects.find((p) => p.rootDir === rootDir);
        if (existing) {
          for (const fw of frameworks) {
            if (!existing.frameworks.includes(fw)) {
              existing.frameworks.push(fw);
            }
          }
        }
      }
    }
  }

  // Strategy 2: Find Python files importing graphql frameworks (no settings.py required)
  const pyFiles = await vscode.workspace.findFiles(
    '**/*.py',
    '{**/node_modules/**,**/.venv/**,**/venv/**,**/env/**,**/site-packages/**,**/migrations/**,**/__pycache__/**}',
    50 // limit to 50 files for quick scan
  );

  for (const uri of pyFiles) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();

    const frameworks: Framework[] = [];

    if (/(?:import\s+graphene|from\s+graphene|from\s+graphene_django)/.test(text)) {
      frameworks.push('graphene');
    }
    if (/(?:import\s+strawberry|from\s+strawberry)/.test(text)) {
      frameworks.push('strawberry');
    }
    if (/(?:import\s+ariadne|from\s+ariadne)/.test(text)) {
      frameworks.push('ariadne');
    }

    if (frameworks.length > 0) {
      const rootDir = await resolveProjectRoot(uri.fsPath);
      if (!seenRoots.has(rootDir)) {
        seenRoots.add(rootDir);
        projects.push({ rootDir, frameworks });
      } else {
        // Merge frameworks into existing project
        const existing = projects.find((p) => p.rootDir === rootDir);
        if (existing) {
          for (const fw of frameworks) {
            if (!existing.frameworks.includes(fw)) {
              existing.frameworks.push(fw);
            }
          }
        }
      }
    }
  }

  // Strategy 3: Find .graphql / .gql schema files
  const graphqlFiles = await vscode.workspace.findFiles(
    '**/*.{graphql,gql}',
    '{**/node_modules/**,**/.venv/**,**/venv/**,**/env/**}',
    10
  );

  if (graphqlFiles.length > 0) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(graphqlFiles[0]);
    const rootDir = workspaceFolder?.uri.fsPath ?? path.dirname(graphqlFiles[0].fsPath);
    if (!seenRoots.has(rootDir)) {
      seenRoots.add(rootDir);
      projects.push({ rootDir, frameworks: ['graphql-schema'] });
    } else {
      // Add graphql-schema framework to existing project
      const existing = projects.find((p) => p.rootDir === rootDir);
      if (existing && !existing.frameworks.includes('graphql-schema')) {
        existing.frameworks.push('graphql-schema');
      }
    }
  }

  log(`[detectProjects] Found ${projects.length} project(s)`);
  for (const p of projects) {
    log(`  rootDir=${p.rootDir}, frameworks=[${p.frameworks.join(', ')}]`);
  }

  return projects;
}

async function resolveProjectRoot(settingsPath: string): Promise<string> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(settingsPath));
  const workspaceRoot = workspaceFolder?.uri.fsPath;

  // Walk up from settings.py dir toward workspace root, looking for manage.py
  let dir = path.dirname(settingsPath);
  while (dir !== path.dirname(dir)) {
    const manageFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(dir, 'manage.py')
    );
    if (manageFiles.length > 0) {
      return dir;
    }
    // Don't go above workspace root
    if (workspaceRoot && dir === workspaceRoot) {
      break;
    }
    dir = path.dirname(dir);
  }

  // Fallback: parent of settings.py dir
  return path.dirname(path.dirname(settingsPath));
}
