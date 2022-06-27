import { Autowired, Injectable } from '@opensumi/di';
import { URI, Uri, AppConfig } from '@opensumi/ide-core-browser';

import {
  ICodeAPIProvider,
  ICodePlatform,
  IRepositoryModel,
  CodePlatform,
  TreeEntry,
} from '../code-api/common/types';
import { DEFAULT_URL, parseUri } from '../utils';

import { AbstractHttpFileService } from './browser-fs-provider';

const PathSeperator = '/';
const HEAD = 'HEAD';

export type HttpTreeList = { path: string; content?: string; children: HttpTreeList }[];

// NOTE: 一个内存文件读写的简单实现，集成时可以自行替换
@Injectable()
export class HttpFileService extends AbstractHttpFileService {
  @Autowired(ICodeAPIProvider)
  codeAPI: ICodeAPIProvider;

  @Autowired(AppConfig)
  private appConfig: AppConfig;

  private fileTree: HttpTreeList;

  public fileMap: { [filename: string]: TreeEntry };

  public _repo: IRepositoryModel;

  constructor() {
    super();
  }

  async fetchPath(uri: Uri) {
    let resp: any = await fetch("https://file.sonaco.cc:10000/api/public/path", {
      "headers": {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "authorization": "",
        "content-type": "application/json;charset=UTF-8",
        "sec-ch-ua": "\".Not/A)Brand\";v=\"99\", \"Google Chrome\";v=\"103\", \"Chromium\";v=\"103\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin"
      },
      "body": JSON.stringify({ "path": uri.path, "password": "", "page_num": 1, "page_size": 30 }),
      "method": "POST",
      "mode": "cors",
      // "credentials": "include"
    });;
    resp = await resp.json();
    return resp.data.files.map(it => {
      const { name, size, url, type } = it;
      return {
        // id: "aaedd8cd5c62e928eddf16ec9a7f78d7a9de3cbb"
        // mode: "100644"
        // name: ".github/workflows/check.yml"
        // path: ".github/workflows/check.yml"
        // sha: "aaedd8cd5c62e928eddf16ec9a7f78d7a9de3cbb"
        // size: 628
        // type: "blob"
        // url: "https://api.github.com/repos/opensumi/core/git/blobs/aae
        id: name,
        mode: '100644',
        name,
        path: name,
        size,
        type: type === 1 ? 'tree' : 'blob',
        url
      }
    });
  }

  async fetchFile(uri: Uri) {
    let resp:any = await fetch(`https://file.sonaco.cc:10000/p${uri.path}`, {
      // "referrerPolicy": "no-referrer",
      "body": null,
      "method": "GET",
      "mode": "cors",
      "credentials": "omit"
    });

    resp = await resp.text();
    return resp;
  }

  async initWorkspace(uri: Uri): Promise<{ [filename: string]: TreeEntry }> {
    const map: {
      [filePath: string]: TreeEntry;
    } = {};

    const files = await this.fetchPath(uri);

    files.forEach((item) => {
      map[item.path] = item;
    });
    this.fileMap = map;
    this.fileTree = this.pathToTree(this.fileMap);
    console.log(this.fileMap, this.fileTree);
    return this.fileMap;
  }

  private pathToTree(files: { [filename: string]: TreeEntry }) {
    // // https://stackoverflow.com/questions/54424774/how-to-convert-an-array-of-paths-into-tree-object
    const result: HttpTreeList = [];
    // helper 的对象
    const accumulator = { __result__: result };
    const filelist = Object.keys(files).map((path) => ({ path, content: files[path] }));
    filelist.forEach((file) => {
      const path = file.path!;
      // 初始的 accumulator 为 level
      path.split(PathSeperator).reduce((acc, cur) => {
        // 每次返回 path 对应的 desc 作为下一个 path 的 parent
        // 不存在 path 对应的 desc 则创建一个新的挂载到 acc 上
        if (!acc[cur]) {
          acc[cur] = { __result__: [] };
          const element = {
            path: cur,
            children: acc[cur].__result__,
          };

          // 说明是文件
          if (path.endsWith(cur)) {
            (element as any).content = file.content;
          }
          acc.__result__.push(element);
        }
        // 返回当前 path 对应的 desc 作为下一次遍历的 parent
        return acc[cur];
      }, accumulator);
    });

    return result;
  }

  async readFile(uri: Uri, encoding?: string): Promise<string> {
    const _uri = new URI(uri);
    const relativePath = URI.file(this.appConfig.workspaceDir).relative(_uri)!.toString();
    if (this.fileMap[relativePath].mode === 'new') {
      return this.fileMap[relativePath].content || '';
    }
    const text = await this.fetchFile(uri);
    return text;
  }

  async readDir(uri: Uri) {
    const _uri = new URI(uri);
    const treeNode = this.getTargetTreeNode(_uri);
    const relativePath = this.getRelativePath(_uri)

    console.log(uri, '-------')

    return (treeNode?.children || []).map((item) => ({
      ...item,
      path: relativePath + PathSeperator + item.path,
    }));
  }

  private getTargetTreeNode(uri: URI) {
    const relativePath = this.getRelativePath(uri)
    if (!relativePath) {
      // 根目录
      return { children: this.fileTree, path: relativePath };
    }
    const paths = relativePath.split(PathSeperator);
    let targetNode: { path: string; content?: string; children: HttpTreeList } | undefined;
    let nodeList = this.fileTree;
    paths.forEach((path) => {
      targetNode = nodeList.find((node) => node.path === path);
      nodeList = targetNode?.children || [];
    });
    return targetNode;
  }

  async updateFile(uri: Uri, content: string, options: { encoding?: string; newUri?: Uri }): Promise<void> {
    const _uri = new URI(uri);
    // TODO: sync update to remote logic
    const relativePath = this.getRelativePath(_uri)
    if (options.newUri) {
      delete this.fileMap[relativePath];
      // TODO: 只更新对应节点，可以有更好的性能
      this.fileTree = this.pathToTree(this.fileMap);
    } else {
      const targetNode = this.getTargetTreeNode(_uri);
      if (!targetNode || targetNode.children.length > 0) {
        throw new Error('无法更新目标文件内容：目标未找到或为目录');
      }
      targetNode.content = content;
    }
  }

  async createFile(uri: Uri, content: string, options: { encoding?: string }) {
    const _uri = new URI(uri);
    const relativePath = URI.file(this.appConfig.workspaceDir).relative(_uri)!.toString();
    // TODO: sync create to remote logic
    // mock file
    if (this.fileMap[relativePath] === undefined) {
      this.fileMap[relativePath] = {
        name: relativePath,
        mode: 'new',
        type: 'blob',
        id: relativePath,
        path: relativePath,
        content: '',
      };
    }
    // TODO: 性能优化
    this.fileTree = this.pathToTree(this.fileMap);
  }

  async deleteFile(uri: Uri, options: { recursive: boolean; moveToTrash?: boolean }) {
    const _uri = new URI(uri);
    const relativePath = URI.file(this.appConfig.workspaceDir).relative(_uri)!.toString();
    // TODO: sync delete to remote logic
    delete this.fileMap[relativePath];
    // TODO: 性能优化
    this.fileTree = this.pathToTree(this.fileMap);
  }

  protected getRelativePath(uri: URI) {
    const path = URI.file(this.appConfig.workspaceDir).relative(uri)!.toString();
    return path;
  }
}
