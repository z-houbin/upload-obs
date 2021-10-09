const core = require('@actions/core')
const fs = require('fs')
const path = require('path')
const AdmZip = require("adm-zip");
const glob = require("glob")
require("x-date")
const ObsClient = require('esdk-obs-nodejs');

async function main() {
    let zipName = core.getInput('name') || 'upload'
    zipName += '-' + new Date().format('yyyymmdd-HH-MM-ss') + '.zip';
    console.log(zipName)

    let folder = core.getInput('path')
    console.log('input.path', folder)

    let searchFiles = await glob.sync(folder, null)
    console.log('search.filed', searchFiles)

    if (searchFiles.length === 0) {
        core.error('no file to upload')
        return
    }

    let zip = new AdmZip(null, null);

    for (let file of searchFiles) {
        if (fs.lstatSync(file).isFile()) {
            zip.addLocalFile(file, null, null)
        } else {
            zip.addLocalFolder(folder)
        }
    }

    await zip.writeZipPromise(zipName, null)
    console.log('zip finish ')

    let server = core.getInput('endpoint');
    let region = core.getInput('region');
    let signature = core.getInput('signature') || 'obs';
    let ak = core.getInput('ak');
    let sk = core.getInput('sk');
    let bucketName = core.getInput('bucket') || 'github-actions-upload';

    let obs = new ObsClient({
        access_key_id: ak,
        secret_access_key: sk,
        server: 'https://' + server,
        signature: signature,
        region: region,
    });

    let objectKey = path.parse(zipName).base;

    await uploadFile(obs, ak, sk, server, region, zipName, bucketName, objectKey)
}

function uploadFile(obs, ak, sk, server, region, filePath, bucketName, objectKey) {
    return new Promise((resolve, reject) => {
        obs.createBucket({
            Bucket: bucketName,
            Location: region,
        }, (err, result) => {
            console.log('createBucket', err, JSON.stringify(result.CommonMsg))
            if (err) {
                reject(err)
                return
            }
            if (result.CommonMsg.Status < 300) {
                /*
                 * Claim a post object request
                 */
                let formParams = {'content-type': 'text/plain'};
                formParams['x-obs-acl'] = obs.enums.AclPublicRead;
                let res = obs.createPostSignatureSync({
                    Bucket: bucketName,
                    Key: objectKey,
                    Expires: 3600,
                    FormParams: formParams
                });

                /*
                 * Start to post object
                 */
                formParams['key'] = objectKey;
                formParams['policy'] = res['Policy'];
                formParams['Accesskeyid'] = ak;

                formParams['signature'] = res['Signature'];

                let boundary = new Date().getTime();

                /*
                 * Construct form data
                 */
                let buffers = [];
                let first = true;

                let contentLength = 0;

                let buffer = [];
                for (let key in formParams) {
                    if (!first) {
                        buffer.push('\r\n');
                    } else {
                        first = false;
                    }

                    buffer.push('--');
                    buffer.push(boundary);
                    buffer.push('\r\n');
                    buffer.push('Content-Disposition: form-data; name="');
                    buffer.push(String(key));
                    buffer.push('"\r\n\r\n');
                    buffer.push(String(formParams[key]));
                }

                buffer = buffer.join('');
                contentLength += buffer.length;
                buffers.push(buffer);

                /*
                 * Construct file description
                 */
                buffer = [];
                buffer.push('\r\n');
                buffer.push('--');
                buffer.push(boundary);
                buffer.push('\r\n');
                buffer.push('Content-Disposition: form-data; name="file"; filename="');
                buffer.push('myfile');
                buffer.push('"\r\n');
                buffer.push('Content-Type: text/plain');
                buffer.push('\r\n\r\n');

                buffer = buffer.join('');
                contentLength += buffer.length;
                buffers.push(buffer);

                /*
                 * Contruct end data
                 */
                buffer = [];
                buffer.push('\r\n--');
                buffer.push(boundary);
                buffer.push('--\r\n');

                buffer = buffer.join('');
                contentLength += buffer.length;
                buffers.push(buffer);

                /*
                 * Add file length to content length
                 */
                contentLength += fs.lstatSync(filePath).size;

                let http = require('http');
                let req = http.request({
                    method: 'POST',
                    host: bucketName + '.' + server,
                    port: 80,
                    path: '/',
                    headers: {
                        'Content-Length': String(contentLength),
                        'User-Agent': 'OBS/Test',
                        'Content-Type': 'multipart/form-data; boundary=' + boundary
                    }
                });

                req.on('response', (response) => {
                    if (response.statusCode < 300) {
                        console.log('Post object successfully.');
                    } else {
                        console.log('Post object failed!!');
                    }
                    let buffers = [];
                    response.on('data', (data) => {
                        buffers.push(data);
                    }).on('end', () => {
                        if (buffers.length > 0) {
                            console.log(buffers.toString());
                        }
                        resolve()
                    });

                }).on('error', (err) => {
                    console.log(err);
                    reject(err);
                });

                /*
                 * Send form data
                 */
                req.write(buffers[0]);

                /*
                 * Send file description
                 */
                req.write(buffers[1]);

                /*
                 * Send file data
                 */
                let readable = fs.createReadStream(filePath);
                readable.on('data', (data) => {
                    req.write(data);
                }).on('end', () => {
                    /*
                     * Send end data
                     */
                    req.write(buffers[2]);
                    req.end();
                }).on('err', () => {
                    req.abort();
                    reject()
                });
            } else {
                reject()
            }
        });
    })
}


main().then(function () {
    core.info('upload finish')
})