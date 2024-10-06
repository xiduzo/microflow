import type { Edge, Node } from "@xyflow/react";
import { dialog } from 'electron';
import * as fs from 'fs';
import { FlowFile } from "../common/types";


export async function exportFlow(nodes: Node[], edges: Edge[]) {
  const file = await dialog.showSaveDialog({
     title: 'Save a file',
     filters: [
       { name: 'Microflow files', extensions: ['microflow'] },
     ]
   })

  if (file.canceled) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    fs.writeFile(file.filePath.toString(), JSON.stringify({ nodes, edges } satisfies FlowFile), err => {
      if(err) {
        return reject(err);
      }

      resolve();
    })
  })
}

export async function importFlow(): Promise<FlowFile | null >{
  const file = await dialog.showOpenDialog({
    title: 'Open a file',
    filters: [
      { name: 'Microflow files', extensions: ['microflow'] },
    ]
  })

  if (file.canceled) {
    return Promise.resolve(null);
  }

  return new Promise<FlowFile>((resolve, reject) => {
    fs.readFile(file.filePaths[0], (err, data) => {
      if(err) {
        return reject(err);
      }

      resolve(JSON.parse(data.toString()));
    })
  })
}
