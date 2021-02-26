'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var qs = _interopDefault(require('querystring'));
var fetch = _interopDefault(require('node-fetch'));
var sleep = _interopDefault(require('sleep-promise'));
var execa = _interopDefault(require('execa'));
var getPort = _interopDefault(require('get-port'));
var Ajv = _interopDefault(require('ajv'));
var path = require('path');
var path__default = _interopDefault(path);
var fs = _interopDefault(require('fs-extra'));

/**
 * Formats Schema validation errors for using with `console.error`
 * @param {Array} errors - Error to format
 * @returns {string} - Errors to show
 */

function formatSchemaErrors(errors) {
  if (errors.length === 0) return '';
  const msgs = errors.map(e => {
    switch (e.keyword) {
      case 'type':
        return `Prop '${e.dataPath}' ${e.message}`;

      case 'additionalProperties':
        return `${e.message}: '${e.params.additionalProperty}' - add this to schema or remove`;

      case 'enum':
        return `Prop '${e.dataPath}' ${e.message}: ${e.params.allowedValues.join(', ')}`;

      default:
        return e.message;
    }
  }).map(error => `🛑 ${error}`);
  return msgs.join('\n');
}
/**
 * Is this path a directory?
 * @param {string} thePath - Path to check
 * @returns {boolean} - is it a directory?
 */

const isDir = thePath => fs.statSync(thePath).isDirectory();

function getAllSubFolders(dir) {
  return fs.readdirSync(dir).reduce((files, file) => {
    // if (file === 'node_modules') return [...files];
    const name = path.join(dir, file);
    return isDir(name) ? [...files, name, ...getAllSubFolders(name)] : [...files];
  }, []);
}
/**
 * Find all files inside a dir, recursively.
 * Synchronous b/c this is used in constructor, which cannot be async.
 * @param {string} dir - Dir path string.
 * @param {string} relativeFrom - path it should be relative from. If not, returns absolute paths.
 * @return {string[]} - Array with all directory names that are inside the directory.
 */


function getAllFolders(dir, relativeFrom = '') {
  if (!isDir(dir)) {
    console.error(`This path is not a directory: ${dir}`);
  }

  const folders = [dir, ...getAllSubFolders(dir)];
  return relativeFrom ? folders.map(folder => path.relative(relativeFrom, folder)) : folders;
}

var type = "object";
var required = [
	"src"
];
var additionalProperties = false;
var properties = {
	src: {
		type: "object",
		title: "Twig Source Files",
		required: [
			"roots"
		],
		additionalProperties: false,
		properties: {
			roots: {
				type: "array",
				description: "Root directories for Twig Loader",
				items: {
					type: "string"
				}
			},
			namespaces: {
				type: "array",
				items: {
					type: "object",
					title: "Individual Namespaces",
					required: [
						"id",
						"paths"
					],
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							description: "Machine Name of Namespace; will use as `@id/file.twig`."
						},
						recursive: {
							type: "boolean",
							"default": false,
							description: "If set, will expand all paths to include all sub-directories."
						},
						paths: {
							type: "array",
							description: "Paths to directories to look for twig files in under this Namespace.",
							items: {
								type: "string"
							}
						}
					}
				}
			}
		}
	},
	relativeFrom: {
		type: "string",
		description: "Path to directory that all paths in this config are relative from. Defaults to CWD."
	},
	alterTwigEnv: {
		type: "array",
		title: "Alter Twig Environment",
		description: "A collection of PHP files and their functions to call that can alter the Twig_Environment right after it is created. This allows adding Twig Extensions and many others things.",
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				file: {
					type: "string",
					description: "PHP file to include that contains the functions to call."
				},
				functions: {
					type: "array",
					description: "PHP Functions to execute with a param of Twig_Environment.",
					items: {
						type: "string"
					}
				}
			}
		}
	},
	hasExtraInfoInResponses: {
		type: "boolean",
		"default": false,
		description: "Should there be an 'info' key on the response object with extra debug details?"
	},
	autoescape: {
		type: "boolean",
		"default": false,
		description: "Passed to creation of Twig Environment."
	},
	debug: {
		type: "boolean",
		"default": true,
		description: "Passed to creation of Twig Environment."
	},
	verbose: {
		type: "boolean",
		"default": false,
		description: "Should the terminal output a lot of info?"
	},
	keepAlive: {
		type: "boolean",
		"default": false,
		title: "Keep render server alive?",
		description: "If false, spins up PHP render server for each batch of render calls. If true, requires deliberate calls to start and stop render server."
	},
	maxConcurrency: {
		type: "integer",
		"default": 100,
		description: "How many concurrent template rendering requests to do. Reduce if you get errors."
	}
};
var configSchema = {
	type: type,
	required: required,
	additionalProperties: additionalProperties,
	properties: properties
};

const ajv = new Ajv({
  useDefaults: true
});
const validateSchemaAndAssignDefaults = ajv.compile(configSchema);
const serverStates = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  READY: 'READY',
  STOPPING: 'STOPPING'
});

class TwigRenderer {
  /**
   * @param {TwigRendererConfig} userConfig - User config
   */
  constructor(userConfig) {
    try {
      execa.shellSync('php --version');
    } catch (err) {
      console.error('Error: php cli required. ', err.message);
      process.exit(1);
    }
    /** @type {Set<number>} */


    this.portsUsed = new Set();
    this.serverState = serverStates.STOPPED;
    this.inProgressRequests = 0;
    this.totalRequests = 0;
    this.completedRequests = 0;
    this.config = Object.assign({}, userConfig);
    const isValid = validateSchemaAndAssignDefaults(this.config);

    if (!isValid) {
      const {
        errors
      } = validateSchemaAndAssignDefaults;
      const msgs = ['Error: Please check config passed into TwigRenderer.', formatSchemaErrors(errors)].join('\n');
      console.error(msgs);

      if (process.env.NODE_ENV === 'testing') {
        process.exitCode = 1;
      } else {
        process.exit(1);
      }

      throw new Error(msgs);
    }

    if (this.config.relativeFrom) {
      if (!fs.existsSync(this.config.relativeFrom)) {
        const msg = `Uh oh, that file path does not exist: ${this.config.relativeFrom}`;
        console.error(msg);
        process.exitCode = 1;
        throw new Error(msg);
      }

      this.config.relativeFrom = path__default.resolve(process.cwd(), this.config.relativeFrom);
    } else {
      this.config.relativeFrom = process.cwd();
    }

    if (this.config.alterTwigEnv) {
      this.config.alterTwigEnv = this.config.alterTwigEnv.map(item => {
        const isAbsolute = path__default.isAbsolute(item.file);
        return {
          file: isAbsolute ? item.file : path__default.resolve(this.config.relativeFrom, item.file),
          functions: item.functions
        };
      });
    }

    this.config = TwigRenderer.processPaths(this.config); // Writing this so `server--sync.php` can use

    fs.writeFileSync(path__default.join(__dirname, 'shared-config.json'), JSON.stringify(this.config, null, '  '));
  }
  /**
   * @param {object} config - this.config
   * @returns {object} - config with checked and modified paths
   */


  static processPaths(config) {
    function checkPaths(paths, {
      relativeFrom,
      recursive = false
    }) {
      const thePaths = paths.map(thePath => {
        const fullPath = path__default.resolve(relativeFrom, thePath);
        const relPath = path__default.relative(relativeFrom, fullPath);

        if (!fs.existsSync(fullPath)) {
          const msg = `This file path does not exist, but was used in config: ${thePath}`;
          console.error(msg);
          process.exitCode = 1;
          throw new Error(msg);
        }

        return recursive ? getAllFolders(fullPath, relativeFrom) : relPath;
      }); // Flattening arrays in case `recursive` was set

      return [].concat(...thePaths);
    }

    const processedConfig = Object.assign({}, config);
    const {
      relativeFrom
    } = processedConfig;
    let {
      roots,
      namespaces
    } = processedConfig.src;
    roots = checkPaths(roots, {
      relativeFrom
    });

    if (namespaces) {
      namespaces = namespaces.map(namespace => ({
        id: namespace.id,
        paths: checkPaths(namespace.paths, {
          relativeFrom,
          recursive: namespace.recursive
        })
      }));
    }

    processedConfig.relativeFrom = relativeFrom;
    processedConfig.src.roots = roots;

    if (namespaces) {
      processedConfig.src.namespaces = namespaces;
    }

    return processedConfig;
  }
  /**
   * Convert Legacy Namespaces Config
   * The old format was an object with the keys being the namespace id and the value the config;
   * the new format is an array of objects that are the exact same config,
   * but the namespace id is the `id` property in the object.
   * @param {object} namespaces - Namespaces config
   * @return {object[]} - Format needed by `config.src.namespaces` (see `config.schema.json`)
   */


  static convertLegacyNamespacesConfig(namespaces) {
    return Object.keys(namespaces).map(id => {
      const value = namespaces[id];
      return Object.assign({
        id
      }, value);
    });
  }

  async getOpenPort() {
    let portSelected = await getPort({
      host: '127.0.0.1' // helps ensure the host being checked matches the PHP server being spun up

    });
    /* eslint-disable no-await-in-loop */
    // pick another port if the one selected has already been taken

    while (this.portsUsed.has(portSelected)) {
      portSelected = await getPort({
        host: '127.0.0.1' // helps ensure the host being checked matches the PHP server being spun up

      });
    }
    /* eslint-enable no-await-in-loop */
    // remember which ports have been assigned to avoid giving out the same port twice


    this.portsUsed.add(portSelected);
    return portSelected;
  }

  async init() {
    if (this.serverState === serverStates.STARTING) {
      // console.log('No need to re-init');
      return this.serverState;
    } // try to handle situation when stopping the current instance but another request comes through


    if (this.serverState === serverStates.STOPPING) {
      // console.log('Server currently stopping -- trying to restart.');
      this.serverState = serverStates.READY;
      return this.serverState;
    }

    if (this.config.verbose) ;

    this.serverState = serverStates.STARTING;
    this.phpServerPort = await this.getOpenPort();
    this.phpServerUrl = `http://127.0.0.1:${this.phpServerPort}`; // @todo Pass config to PHP server a better way than writing JSON file, then reading in PHP

    const sharedConfigPath = path__default.join(__dirname, `shared-config--${this.phpServerPort}.json`);
    await fs.writeFile(sharedConfigPath, JSON.stringify(this.config, null, '  '));
    const phpMemoryLimit = '4048M'; // @todo make user configurable

    const params = ['-d', `memory_limit=${phpMemoryLimit}`, path__default.join(__dirname, 'server--async.php'), this.phpServerPort, sharedConfigPath];
    this.phpServer = execa('php', params, {
      cleanup: true,
      detached: false
    }); // the PHP close event appears to happen first, THEN the exit event

    this.phpServer.on('close', async () => {
      // console.log(`Server ${this.phpServerPort} event: 'close'`);
      this.serverState = serverStates.STOPPING;
    });
    this.phpServer.on('exit', async () => {
      // console.log(`Server ${this.phpServerPort} event: 'exit'`);
      await fs.unlink(sharedConfigPath);
      this.serverState = serverStates.STOPPED;
    });
    this.phpServer.on('disconnect', () => {// console.log(`Server ${this.phpServerPort} event: 'disconnect'`);
    });
    this.phpServer.on('error', () => {// console.log(`Server ${this.phpServerPort} event: 'error'`);
    }); // @todo wrap this in config for seeing it besides `verbose` - too noisy

    this.phpServer.stdout.pipe(process.stdout);
    this.phpServer.stderr.pipe(process.stderr);

    if (this.config.verbose) ;

    await this.checkServerWhileStarting();
    return this.serverState;
  }

  stop() {
    // console.log(`stopping server with port ${this.phpServerPort}`);
    this.serverState = serverStates.STOPPED;
    this.phpServer.kill(); // ↓ not 100% sure if we need this w/ execa; other exec examples seem to do this for cleanup

    this.phpServer.removeAllListeners();
  }

  async closeServer() {
    // console.log('checking if we can stop the server...');
    if (this.config.keepAlive === false) {
      if (this.completedRequests === this.totalRequests && this.inProgressRequests === 0 && (this.serverState !== serverStates.STOPPING || this.serverState !== serverStates.STOPPED)) {
        this.stop();
      } else {
        setTimeout(() => {
          if (this.completedRequests === this.totalRequests && this.inProgressRequests === 0) {
            this.stop();
          }
        }, 300);
      }
    }
  }
  /**
   * Is PHP sever ready to render?
   * @returns {boolean} - is ready
   */


  async checkIfServerIsReady() {
    if (this.config.verbose) ;

    try {
      const res = await fetch(this.phpServerUrl);
      const {
        ok
      } = res;

      if (ok) {
        this.serverState = serverStates.READY;
      }

      if (this.config.verbose) ;

      return ok;
    } catch (e) {
      return false;
    }
  }

  async checkServerWhileStarting() {
    while (this.serverState === serverStates.STARTING) {
      // console.log(`checkServerWhileStarting: ${this.serverState}`);
      await this.checkIfServerIsReady();
      await sleep(100);
    }

    return this.serverState;
  }

  getServerState() {
    return this.serverState;
  }
  /**
   * Render Twig Template
   * @param {string} template - Template path
   * @param {object} data - Data to pass to template
   * @returns {Promise<{ok: boolean, html: string, message: string}>} - Render results
   */


  async render(template, data = {}) {
    const result = await this.request('renderFile', {
      template,
      data
    });
    this.closeServer(); // try to cleanup the current server instance before returning results

    return result;
  }
  /**
   * Render Twig String
   * @param {string} template - inlined Twig template
   * @param {object} data - Data to pass to template
   * @returns {Promise<{ok: boolean, html: string, message: string}>}  - Render results
   */


  async renderString(template, data = {}) {
    const result = await this.request('renderString', {
      template,
      data
    });
    this.closeServer(); // try to cleanup the current server instance before returning results

    return result;
  }

  async getMeta() {
    return this.request('meta');
  }

  async request(type$$1, body = {}) {
    this.totalRequests += 1;

    if (this.serverState === serverStates.STOPPED) {
      await this.init();
    }

    while (this.serverState !== serverStates.READY) {
      await sleep(250);
    }

    while (this.inProgressRequests > this.config.maxConcurrency) {
      await sleep(250);
    }

    if (this.config.verbose) {
      console.log(`About to render & server on port ${this.phpServerPort} is ${this.serverState}`);
    }

    const attempts = 3;
    let attempt = 0;
    let results;

    while (attempt < attempts) {
      try {
        this.inProgressRequests += 1;
        const requestUrl = `${this.phpServerUrl}?${qs.stringify({
          type: type$$1
        })}`; // @todo Fail if no response after X seconds

        const res = await fetch(requestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        const {
          status,
          headers,
          ok
        } = res;
        const contentType = headers.get('Content-Type');
        const warning = headers.get('Warning');

        if (contentType === 'application/json') {
          results = await res.json();
        } else {
          results = {
            ok,
            message: warning,
            html: await res.text()
          };
        }

        this.inProgressRequests -= 1;
        this.completedRequests += 1;

        if (this.config.verbose) {
          // console.log('vvvvvvvvvvvvvvv');
          console.log(`Render request received: Ok: ${ok ? 'true' : 'false'}, Status Code: ${status}, type: ${type$$1}. ${body.template ? `template: ${body.template}` : ''}`);

          if (warning) {
            console.warn('Warning: ', warning);
          } // console.log(results);
          // console.log(`End: ${templatePath}`);
          // console.log('^^^^^^^^^^^^^^^^');
          // console.log();

        }

        break;
      } catch (e) {
        results = {
          ok: false,
          message: e.message
        };
        attempt += 1;
        this.inProgressRequests -= 1;
      }
    }

    return results;
  }

}

module.exports = TwigRenderer;
//# sourceMappingURL=twig-renderer.js.map
