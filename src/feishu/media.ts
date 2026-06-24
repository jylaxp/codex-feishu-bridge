import * as fs from 'fs';
import * as path from 'path';
import { larkClient } from './client';

const imageUploadCache: Record<string, Promise<string>> = {};

export async function processMarkdownImages(md: string): Promise<string> {
  if (!md) return md;
  const regex = /!\[([^\]]*)\]\(((?:\/|file:\/\/)[^)]+)\)/g;
  let newMd = md;
  const matches = [...md.matchAll(regex)];
  for (const m of matches) {
    const fullMatch = m[0];
    const alt = m[1];
    let filePath = m[2];
    
    if (filePath.startsWith('file://')) {
      filePath = filePath.substring(7);
    }

    const validExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const isImageExt = validExts.some(ext => filePath.toLowerCase().endsWith(ext));

    if (isImageExt && fs.existsSync(filePath)) {
      if (!imageUploadCache[filePath]) {
        imageUploadCache[filePath] = (async () => {
          try {
            const res = await larkClient.im.v1.image.create({
              data: {
                image_type: 'message',
                image: fs.readFileSync(filePath)
              }
            });
            if (res?.image_key) {
              return res.image_key;
            }
          } catch (e) {
            console.error(`Failed to upload local image ${filePath} to Lark:`, e);
          }
          return filePath;
        })();
      }
      
      const imageKeyOrPath = await imageUploadCache[filePath];
      if (imageKeyOrPath !== filePath) {
        newMd = newMd.replace(fullMatch, `![${alt}](${imageKeyOrPath})`);
      }
    }
  }
  return newMd;
}

export async function uploadLocalFilesInMarkdown(md: string, chatId: string, replyMessageId: string) {
  if (process.env.ENABLE_AUTO_FILE_UPLOAD !== 'true') return;
  if (!md) return;
  
  const regex = /(?<!!)\[([^\]]*)\]\(((?:\/|file:\/\/)[^)]+)\)/g;
  const matches = [...md.matchAll(regex)];
  
  for (const m of matches) {
    const fileName = m[1];
    let filePath = m[2];
    
    if (filePath.startsWith('file://')) {
      filePath = filePath.substring(7);
    }

    if (fs.existsSync(filePath)) {
      try {
        const ext = path.extname(filePath).toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
        if (imageExts.includes(ext)) continue;

        const fileSize = fs.statSync(filePath).size;
        if (fileSize > 30 * 1024 * 1024) {
          console.warn(`File ${filePath} is too large to auto-upload (>30MB).`);
          continue;
        }

        const res = await larkClient.im.v1.file.create({
          data: {
            file_type: 'stream',
            file_name: fileName || path.basename(filePath),
            file: fs.readFileSync(filePath)
          }
        });

        if (res?.file_key) {
          await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ file_key: res.file_key }),
              msg_type: 'file'
            }
          });
        }
      } catch (e) {
        console.error(`Failed to auto-upload file ${filePath}:`, e);
      }
    }
  }
}
