import fs from 'fs/promises';
import { Permissions } from '../config/permissions.js';
import { validatePath } from '../utils/path-utils.js';
import { getFileStats, applyFileEdits } from '../utils/file-utils.js';
import {
  ReadFileArgsSchema,
  ReadMultipleFilesArgsSchema,
  WriteFileArgsSchema,
  EditFileArgsSchema,
  GetFileInfoArgsSchema,
  MoveFileArgsSchema,
  DeleteFileArgsSchema,
  RenameFileArgsSchema
} from '../schemas/file-operations.js';
import path from 'path';

export async function handleReadFile(
  args: unknown,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = ReadFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
  }
  const { path: filePath, maxBytes } = parsed.data;
  const validPath = await validatePath(filePath, allowedDirectories, symlinksMap, noFollowSymlinks);
  
  // Check file size before reading
  const stats = await fs.stat(validPath);
  const effectiveMaxBytes = maxBytes ?? (10 * 1024); // Default 10KB
  if (stats.size > effectiveMaxBytes) {
    throw new Error(`File size (${stats.size} bytes) exceeds the maximum allowed size (${effectiveMaxBytes} bytes).`);
  }
  
  const content = await fs.readFile(validPath, "utf-8");
  return {
    content: [{ type: "text", text: content }],
  };
}

export async function handleReadMultipleFiles(
  args: unknown,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for read_multiple_files: ${parsed.error}`);
  }
  const { paths, maxBytesPerFile } = parsed.data;
  const effectiveMaxBytes = maxBytesPerFile ?? (10 * 1024); // Default 10KB per file
  
  const results = await Promise.all(
    paths.map(async (filePath: string) => {
      try {
        const validPath = await validatePath(filePath, allowedDirectories, symlinksMap, noFollowSymlinks);
        
        // Check file size before reading
        const stats = await fs.stat(validPath);
        if (stats.size > effectiveMaxBytes) {
          return `${filePath}: Error - File size (${stats.size} bytes) exceeds the maximum allowed size (${effectiveMaxBytes} bytes).`;
        }
        
        const content = await fs.readFile(validPath, "utf-8");
        return `${filePath}:\n${content}\n`;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return `${filePath}: Error - ${errorMessage}`;
      }
    }),
  );
  return {
    content: [{ type: "text", text: results.join("\n---\n") }],
  };
}

export async function handleCreateFile(
  args: unknown,
  permissions: Permissions,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = WriteFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for create_file: ${parsed.error}`);
  }
  
  const validPath = await validatePath(
    parsed.data.path,
    allowedDirectories,
    symlinksMap,
    noFollowSymlinks,
    { checkParentExists: false } // Add this option
  );
  
  // Check if file already exists before writing
  try {
    await fs.access(validPath);
    // If access succeeds, file exists
    throw new Error(`File already exists: ${parsed.data.path}`);
  } catch (error) {
     const msg = error instanceof Error ? error.message : String(error);
     if (!msg.includes('ENOENT')) { // Rethrow if it's not a "file not found" error
       throw error;
     }
     // If ENOENT, proceed with creation
     // Ensure create permission
     if (!permissions.create && !permissions.fullAccess) {
        throw new Error('Cannot create new file: create permission not granted (requires --allow-create)');
     }
     // Ensure parent directory exists
     const parentDir = path.dirname(validPath);
     await fs.mkdir(parentDir, { recursive: true });

     await fs.writeFile(validPath, parsed.data.content, "utf-8");
     return {
       content: [{ type: "text", text: `Successfully created ${parsed.data.path}` }],
     };
  }
}

export async function handleModifyFile(
  args: unknown,
  permissions: Permissions,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = WriteFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for modify_file: ${parsed.error}`);
  }
  
  const validPath = await validatePath(parsed.data.path, allowedDirectories, symlinksMap, noFollowSymlinks);
  
  // Check if file exists
  try {
    await fs.access(validPath);
    
    if (!permissions.edit && !permissions.fullAccess) {
      throw new Error('Cannot modify file: edit permission not granted (requires --allow-edit)');
    }
    
    await fs.writeFile(validPath, parsed.data.content, "utf-8");
    return {
      content: [{ type: "text", text: `Successfully modified ${parsed.data.path}` }],
    };
  } catch (error) {
    throw new Error('Cannot modify file: file does not exist');
  }
}

export async function handleEditFile(
  args: unknown,
  permissions: Permissions,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = EditFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for edit_file: ${parsed.error}`);
  }
  
  // Enforce permission checks
  if (!permissions.edit && !permissions.fullAccess) {
    throw new Error('Cannot edit file: edit permission not granted (requires --allow-edit)');
  }
  
  const { path: filePath, edits, dryRun, maxBytes } = parsed.data;
  const validPath = await validatePath(filePath, allowedDirectories, symlinksMap, noFollowSymlinks);
  
  // Check file size before attempting to read/edit
  const stats = await fs.stat(validPath);
  const effectiveMaxBytes = maxBytes ?? (10 * 1024); // Default 10KB
  if (stats.size > effectiveMaxBytes) {
    throw new Error(`File size (${stats.size} bytes) exceeds the maximum allowed size (${effectiveMaxBytes} bytes) for editing.`);
  }
  
  const result = await applyFileEdits(validPath, edits, dryRun);
  return {
    content: [{ type: "text", text: result }],
  };
}

export async function handleGetFileInfo(
  args: unknown,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = GetFileInfoArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
  }
  const validPath = await validatePath(parsed.data.path, allowedDirectories, symlinksMap, noFollowSymlinks);
  const info = await getFileStats(validPath);
  return {
    content: [{ type: "text", text: Object.entries(info)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n") }],
  };
}

export async function handleMoveFile(
  args: unknown,
  permissions: Permissions,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = MoveFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
  }
  
  // Enforce permission checks
  if (!permissions.move && !permissions.fullAccess) {
    throw new Error('Cannot move file: move permission not granted (requires --allow-move)');
  }
  
  const validSourcePath = await validatePath(parsed.data.source, allowedDirectories, symlinksMap, noFollowSymlinks); // No option here, source must exist

  const validDestPath = await validatePath(
    parsed.data.destination,
    allowedDirectories,
    symlinksMap,
    noFollowSymlinks,
    { checkParentExists: false } // Add option here for destination
  );
  // Ensure destination parent exists before moving (fs.rename requires parent)
  const destParentDir = path.dirname(validDestPath);
  try {
      await fs.access(destParentDir);
  } catch {
      throw new Error(`Destination parent directory does not exist: ${path.dirname(parsed.data.destination)}`);
  }

  await fs.rename(validSourcePath, validDestPath);
  return {
    content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
  };
}

export async function handleDeleteFile(
  args: unknown,
  permissions: Permissions,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = DeleteFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for delete_file: ${parsed.error}`);
  }
  
  // Enforce permission checks
  if (!permissions.delete && !permissions.fullAccess) {
    throw new Error('Cannot delete file: delete permission not granted (requires --allow-delete)');
  }
  
  const validPath = await validatePath(parsed.data.path, allowedDirectories, symlinksMap, noFollowSymlinks);
  
  try {
    // Check if file exists
    await fs.access(validPath);
    await fs.unlink(validPath);
    return {
      content: [{ type: "text", text: `Successfully deleted ${parsed.data.path}` }],
    };
  } catch (error) {
    throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function handleRenameFile(
  args: unknown,
  permissions: Permissions,
  allowedDirectories: string[],
  symlinksMap: Map<string, string>,
  noFollowSymlinks: boolean
) {
  const parsed = RenameFileArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for rename_file: ${parsed.error}`);
  }
  
  // Enforce permission checks - rename requires the rename permission
  if (!permissions.rename && !permissions.fullAccess) {
    throw new Error('Cannot rename file: rename permission not granted (requires --allow-rename)');
  }
  
  const validSourcePath = await validatePath(parsed.data.path, allowedDirectories, symlinksMap, noFollowSymlinks);
  
  // Get the directory from the source path
  const directory = path.dirname(validSourcePath);
  
  // Create the destination path using the same directory and the new name
  const destinationPath = path.join(directory, parsed.data.newName);
  
  // Validate the destination path
  const validDestPath = await validatePath(destinationPath, allowedDirectories, symlinksMap, noFollowSymlinks);
  
  // Check if destination already exists
  try {
    await fs.access(validDestPath);
    throw new Error(`Cannot rename file: a file with name "${parsed.data.newName}" already exists in the directory`);
  } catch (error) {
    // We want this error - it means the destination doesn't exist yet
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  
  // Perform the rename operation
  await fs.rename(validSourcePath, validDestPath);
  
  return {
    content: [{ type: "text", text: `Successfully renamed ${parsed.data.path} to ${parsed.data.newName}` }],
  };
} 