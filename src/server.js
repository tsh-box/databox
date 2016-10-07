var Config = require('./config.json');
var http = require('http');
var express = require('express');
var bodyParser = require('body-parser');
var request = require('request');
var io = require('socket.io');
var url = require('url');

var app = express();

module.exports = {
	proxies: {},
	launch: function (port, conman) {
		var server = http.createServer(app);
		var installingApps = [];
		io = io(server);

		this.proxies['store'] = Config.storeUrl;

		app.enable('trust proxy');
		app.set('views', 'src/www');
		app.set('view engine', 'pug');
		app.use(express.static('src/www'));

		app.use((req, res, next) => {
			var firstPart = req.path.split('/')[1];
			if (firstPart in this.proxies) {
				var replacement = this.proxies[firstPart];
				if(replacement.indexOf('://') != -1)
				{
					var parts = url.parse(replacement);
					parts.pathname = req.baseUrl + req.path.substring(firstPart.length + 1);
					parts.query = req.query;
					var proxyURL = url.format(parts);
				}
				else {
					var proxyURL = url.format({
						protocol: req.protocol,
						host: replacement,
						pathname: req.baseUrl + req.path.substring(firstPart.length + 1),
						query: req.query
					});
				}

				console.log("[Proxy] " + req.method + ": " + req.url + " => " + proxyURL);
				return req
					.pipe(request(proxyURL))
					.on('error', (e) => {
						console.log(e);
					})
					.pipe(res)
					.on('error', (e) => {
						console.log(e);
					});
			}
			next();
		});

		app.use(bodyParser.urlencoded({extended: false}));

		app.get('/', (req, res) => {
			res.render('index')
		});
		app.get('/slayer', (req, res) => {
			res.render('slayer')
		});

		app.get('/list-containers', (req, res) => {
			conman.listContainers()
				.then((containers) => {
					for (var installingApp of installingApps) {
						var appName = '/' + installingApp;
						var found = false;
						for (var installedApp of containers) {
							if (installedApp.Names.indexOf(appName) != -1) {
								found = true;
							}
						}
						if (!found) {
							containers.push({Names: [appName], State: "installing"});
						}
					}
					res.json(containers);
				});
			//.catch()
		});

		app.get('/list-store', (req, res) => {
			request('https://' + Config.registryUrl + '/v2/_catalog', (error, response, body) => {
				if (error) {
					res.json(error);
					return
				}
				var repositories = JSON.parse(body).repositories;
				var repocount = repositories.length;
				var manifests = [];

				repositories.map((repo) => {
					request.post({'url': Config.storeUrl + '/app/get/', 'form': {'name': repo}}, (err, data) => {

						if (err) {
							//do nothing
							return;
						}

						body = JSON.parse(data.body);
						if (typeof body.error == 'undefined' || body.error != 23) {
							manifests.push(body);
						}
						repocount--;
						if (repocount <= 0) {
							res.json(manifests);
						}
					});
				});

			});
		});


		app.post('/pull-app', (req, res) => {
			conman.pullImage(Config.registryUrl + req.body.name + ':' + req.body.tag)
				.then((err, data) => {
					if (err) {
						return;
					}
					stream.pipe(data)
				});
		});

		app.post('/install', (req, res) => {
			var sla = JSON.parse(req.body.sla);
			var name = sla.name;
			console.log(JSON.stringify(installingApps));
			repoTag = name;
			installingApps.push(name);

			io.emit('docker-create', repoTag);
			conman.launchContainer(repoTag, sla)
				.then((info) => {
					console.log("CONTAINER CREATED", info);
					var index = installingApps.indexOf(name);
					if (index != -1) {
						installingApps.splice(index, 1)
					}
					this.proxies[info.name] = 'localhost:' + info.port;
					res.json(info);
				});
		});

		app.post('/restart', (req, res) => {
			console.log("Restarting " + req.body.id);
			conman.getContainer(req.body.id)
				.then((cont) => {
					return conman.stopContainer(cont)
				})
				.then((cont) => {
					return conman.startContainer(cont)
				})
				.then((data) => {
					console.log("Restarted " + data.id);

					res.json(data);
				})
				.catch((err)=> {
					res.json(err);
				})
		});


		app.post('/uninstall', (req, res) => {
			console.log("Uninstalling " + req.body.id);
			conman.getContainer(req.body.id)
				.then((cont)=> {
					return conman.stopContainer(cont)
				})
				.then((cont)=> {
					return conman.removeContainer(cont)
				})
				.then((data)=> {
					console.log("Uninstalled " + data.id);
					res.json(data);
				})
				.catch((err)=> {
					res.json(err)
				});

		});


		io.on('connection', (socket) => {

			var emitter = conman.getDockerEmitter();

			emitter.on("connect", () => {
				socket.emit('docker-connect');
			});
			emitter.on("disconnect", () => {
				socket.emit('docker-disconnect');
			});
			emitter.on("_message", (message) => {
				socket.emit('docker-_message', message);
			});
			emitter.on("create", (message) => {
				socket.emit('docker-create', message);
			});
			emitter.on("start", (message) => {
				socket.emit('docker-star', message);
			});
			emitter.on("start", (message) => {
				socket.emit('docker-stop', message);
			});
			emitter.on("die", (message) => {
				socket.emit('docker-die', message);
			});
			emitter.on("destroy", (message) => {
				socket.emit('docker-destroy', message);
			});
			emitter.start();

		});

		server.listen(port);
	}
};
