import type {StorageEngine} from 'multer';
import {randomUUID,createHash} from 'node:crypto';
import {createWriteStream, promises as fs} from 'node:fs';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

/** Calculate the content digest during upload. Replaying a large request must not
 * delay the accepted response with a second read of the entire source file. */
export function videoUploadStorage(directory:string):StorageEngine {
  return {
    _handleFile(_req,file,cb) {
      const filename=randomUUID()+(path.extname(file.originalname)||'.mp4');
      const target=path.join(directory,filename);
      const hash=createHash('sha256');
      let size=0;
      const meter=new Transform({transform(chunk,_encoding,done){size+=chunk.length;hash.update(chunk);done(null,chunk);}});
      pipeline(file.stream,meter,createWriteStream(target,{flags:'wx'})).then(()=>{
        const metadata={destination:directory,filename,path:target,size,sha256:hash.digest('hex')};
        cb(null,metadata);
      }).catch(async(e)=>{await fs.unlink(target).catch(()=>{});cb(e);});
    },
    _removeFile(_req,file,cb){fs.unlink(file.path).then(()=>cb(null)).catch(cb);}
  };
}

