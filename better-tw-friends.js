// ==UserScript==
// @name            TW Best Friends
// @description     Sending tamboola currency made easier
// @author          xShteff, Diggo11
// @match           https://*.the-west.net/game.php*
// @match           https://*.the-west.de/game.php*
// @match           https://*.the-west.pl/game.php*
// @match           https://*.the-west.nl/game.php*
// @match           https://*.the-west.se/game.php*
// @match           https://*.the-west.ro/game.php*
// @match           https://*.the-west.com.pt/game.php*
// @match           https://*.the-west.cz/game.php*
// @match           https://*.the-west.es/game.php*
// @match           https://*.the-west.ru/game.php*
// @match           https://*.the-west.com.br/game.php*
// @match           https://*.the-west.org/game.php*
// @match           https://*.the-west.hu/game.php*
// @match           https://*.the-west.gr/game.php*
// @match           https://*.the-west.dk/game.php*
// @match           https://*.the-west.sk/game.php*
// @match           https://*.the-west.fr/game.php*
// @match           https://*.the-west.it/game.php*
// @grant           none
// @run-at          document-end
// ==/UserScript==

/**
 * A map of player ids to plain objects describing the character
 * @type {Object}
 */
var friends = {};

/**
 * A map of player ids to unix timestamps
 * @type {Object}
 */
var lastSent = {};

/**
 * Records whether an ses:*_received event has been signalled since last downloading logs, assuming true upon login
 * @type {Boolean}
 */
var newLogs = true;

/**
 * A map containing information such as the most recent log processed, etc
 * @type {Object}
 */
var logsMetadata = null;

/**
 * A map of player ids to eg {total: Number, frequency: [js timestamp, ...]}
 * @type {Object}
 */
var playerLogs = null;

/**
 * A map of ses drop types to ses currency received from this drop type
 * @type {Object}
 */
var dropTypeLogs = null;

/**
 * We don't want a race between two log processing functions
 * @type {Boolean}
 */
var logsLocked = false;

/**
 * Returns a list of keys for active events, eg Hearts. Practically guaranteed to have a length of 0 if no events are
 * running and a length of 1 otherwise (2 or more = internal beta only).
 * @returns {Array}
 */
function getActiveSesKeys() {
	return Object.keys(Game.sesData);
}

/**
 * Returns the number of seconds until you can send ses currency to a friend, or 0 if you can send it immediately.
 * Friends list must be initiated first.
 * @param {Number} friendId
 * @returns {Number}
 */
function timeUntilSesReady(friendId) {
	if (!lastSent.hasOwnProperty(friendId)) {
		return 0;
	}
	var yesterday = Date.now()/1000 - 3600*23;
	return Math.max(0, Math.floor(lastSent[friendId] - yesterday));
}

/**
 * Returns the number of friends you can currently send ses currency to. Friends list must be initiated first.
 * @returns {Number}
 */
function getSesReadyCount() {
	var count = 0;
	$.each(friends, function (playerId, client) {
		if (timeUntilSesReady(playerId) === 0) {
			count++;
		}
	});
	return count;
}

/**
 * Returns the total number of friends you have. Friends list must be initiated first.
 * @returns {Number}
 */
function getFriendCount() {
	return Object.keys(friends).length;
}

/**
 * Initiates the friend list and its twin, the last sent list. Do NOT run before establishing an event is ongoing.
 * Returns a promise with the message from the server, if any, but consider it void if resolved successfully.
 * @returns {Promise}
 */
function getFriendsList() {
	return new Promise(function (resolve, reject) {
		Ajax.remoteCallMode('friendsbar', 'search', {search_type: 'friends'}, function (data) {
			if (data.error) {
				return reject(data.msg);
			}

			$.each(data.players, function (i, client) {
				if (client.player_id !== Character.playerId) {
					friends[client.player_id] = west.storage.FriendsBar.prototype.normalizeAvatars_(client, i);
					delete friends[client.player_id].experience;
					delete friends[client.player_id].x;
					delete friends[client.player_id].y;
				}
			});

			var sesKey = getActiveSesKeys()[0];
			$.each(data.eventActivations, function (i, eventActivation) {
				if (eventActivation.event_name === sesKey) {
					lastSent[eventActivation.friend_id] = eventActivation.activation_time;
				}
			});

			return resolve(data.msg);
		});
	});
}

/**
 * Sends ses currency to a friend. Do NOT run before establishing an event is ongoing, even if you somehow obtain a
 * friend id without initiating the friend list first (congratulations). Returns a promise with the response message.
 * @param {Number} friendId
 * @returns {Promise}
 */
function sendSesCurrency(friendId) {
	return new Promise(function (resolve, reject) {
		Ajax.remoteCall('friendsbar', 'event', {player_id: friendId, event: getActiveSesKeys()[0]}, function (data) {
			if (data.error) {
				return reject(data.msg);
			}
			lastSent[friendId] = data.activationTime;
			return resolve(data.msg);
		});
	});
}

/**
 * Downloads any new ses currency logs and processes them. If the last seen ses key does not match then it deletes the
 * currently held logs. Optionally adds a delay between log fetches to avoid streaks of bad luck. If you want more info
 * see the functions below.
 * @param {Boolean} background
 * @returns {Promise}
 */
function processLogs(background) {
	if (logsLocked) throw new Error("Please don't try and process the logs twice at the same time.");
	if (!newLogs) return Promise.resolve();
	logsLocked = true;

	loadLogs();
	var sesKey = getActiveSesKeys()[0];
	if (sesKey !== logsMetadata.sesKey) {
		playerLogs = {};
		dropTypeLogs = {};
		logsMetadata.sesKey = sesKey;
	}

	return new Promise(function (resolve, reject) {
		var generator = processLogsBatches(sesKey, background, resolve, reject);
		generator.next();
		generator.next(() => generator.next());
	});
}

/**
 * This whole function is a big hack to emulate ES7 async/await. If it were supported by current browsers, we could
 * simply make processLogs async and await each processLogBatch there in a loop, then resolve the promise. We can't use
 * promises' .then either because we don't know how many pages there are in advance; we would need something like .while
 * and severe mental backflips. The next best thing is the yield keyword provided by generators, which allows us to
 * "pause" execution in a similar way. We obviously can't stick this in the promise directly so it exists here instead,
 * and processLogs just calls it and hands along its resolve and reject functions.
 *
 * @see https://davidwalsh.name/async-generators
 * @see https://esdiscuss.org/topic/retrieving-generator-references
 *
 * The core idea here is that once a batch of logs is done processing asynchronously, it resumes the generator, which
 * starts the next batch. To do that, we need to pass a reference to this generator onto processLogBatch. Generators are
 * not initialised with the new keyword, so annoyingly `this` does not point to the generator object. However, it is
 * possible to resume suspended generators with an overwritten value. This is why we yield immediately -- so processLogs
 * can resume the execution with a reference to the generator object.
 *
 * After that it is relatively straightforward. The generator is suspended and resumed via the callback until there are
 * no more pages of logs to process. At that point we update the newestSeen data, save everything to local storage and
 * resolve the promise satisfied everything is ready to open the window.
 * @param {String} sesKey
 * @param {Boolean} background
 * @param {Function} resolve
 * @param {Function} reject
 */
function* processLogsBatches(sesKey, background, resolve, reject) {
	var callback = yield;
	var stats = {newest: logsMetadata.newestSeen || 0, hasNext: true};
	var page = 1;
	do {
		yield processLogBatch(sesKey, page++, stats, callback, background);
	} while (stats.hasNext);
	logsMetadata.newestSeen = stats.newest;
	saveLogs();
	newLogs = false;
	logsLocked = false;
	return resolve();
}

/**
 * Processes a given page of logs and updates playerLogs and dropTypeLogs. Stats object is used like pass-by-reference
 * to return both the newest log date seen and whether more new log pages are available.
 * @param {String} sesKey
 * @param {Number} page
 * @param {Object} stats
 * @param {Function} callback
 * @param {Boolean} background
 */
function processLogBatch(sesKey, page, stats, callback, background) {
	Ajax.remoteCallMode('ses', 'log', {ses_id: sesKey, page: page, limit: 100}, function (data) {
		if (data.error) {
			logsLocked = false;
			return reject(data.msg);
		}

		stats.hasNext = !data.entries.some(function (entry, i) {
			if (entry.date <= logsMetadata.newestSeen) {
				return true; // short circuit
			} else if (i === 0 && entry.date > stats.newest) {
				stats.newest = entry.date;
			}

			dropTypeLogs[entry.type] = (dropTypeLogs[entry.type] || 0) + +entry.value;
			if (entry.type === 'friendDrop') {
				var senderId = JSON.parse(entry.details).player_id;
				if (playerLogs.hasOwnProperty(senderId)) {
					playerLogs[senderId].total += +entry.value;
					playerLogs[senderId].frequency.push(entry.date);
				} else {
					playerLogs[senderId] = {total: +entry.value, frequency: [entry.date]};
				}
			}
		}) && data.hasNext;

		if (background) {
			setTimeout(callback, 1000);
		} else {
			callback();
		}
	});
}

/**
 * Load playerLogs and dropTypeLogs from local storage.
 */
function loadLogs() {
	logsMetadata = JSON.parse(localStorage.getItem('xshteff.betterfriends.logsMetadata')) || {};
	playerLogs = JSON.parse(localStorage.getItem('xshteff.betterfriends.playerLogs')) || {};
	dropTypeLogs = JSON.parse(localStorage.getItem('xshteff.betterfriends.dropTypeLogs')) || {};
}

/**
 * Save playerLogs and dropTypeLogs into local storage.
 */
function saveLogs() {
	var prefix = 'xshteff.betterfriends.';
	localStorage.setItem(prefix + 'logsMetadata', JSON.stringify(logsMetadata));
	localStorage.setItem(prefix + 'playerLogs', JSON.stringify(playerLogs));
	localStorage.setItem(prefix + 'dropTypeLogs', JSON.stringify(dropTypeLogs));
}

// getFriendsList()
// .then(getSesReadyCount)
// .then(x => console.log(x));
//
// sendSesCurrency(1337)
// .then(msg => MessageSuccess(msg).show())
// .catch(msg => MessageError(msg).show());

function initialiseScript() {
	var sesKeys = getActiveSesKeys();
	if (sesKeys.length === 0) return;

	getFriendsList().then(function () {
		getSesReadyCount(); // display it pls Allen
		getFriendCount(); // display it pls Allen
		return processLogs(true)
	}).then(initialiseButton);

	EventHandler.listen('friend_added', function (client) {
		friends[client.playerId] = {
			avatar: client.avatar,
			class: client.charClass,
			level: client.level,
			name: client.pname,
			player_id: client.playerId,
			profession_id: client.professionId,
			subclass: client.subClass
		};
	});

	EventHandler.listen('friend_removed', function (friendId) {
		delete friends[friendId];
	});

	EventHandler.listen(Game.sesData[sesKeys[0]].counter.key, function (amount) {
		newLogs = true;
	});
}

var generateSendLink = function(pid) {
	return $('<a></a>').text('Send').click(function() {
		sendSesCurrency(pid)
			.then(msg => MessageSuccess(msg).show())
			.catch(msg => MessageError(msg).show());
		$(this).parent().parent().remove();
	});
};
var appendPlayerToTable = function(table, pid) {
	var pLog = playerLogs[pid];
	var totalAmount, logToolTip, currentText, currentDate;
	if(pLog === undefined){
		totalAmount = 0;
		logToolTip = $('<a>').attr('title', '<div>Player did not send you any currency yet.</div>').text(' (' + totalAmount + ')');
	}
	else{
		totalAmount = pLog.total;
		logToolTip = $('<a>').attr('title', '<div><center><b>Dates you received currency from:</b> </br>').text(' (' + totalAmount + ')');
		for(var i = 0; i < playerLogs[pid].frequency.length; i++) {
			currentText = logToolTip.attr('title');
			currentDate = new Date(playerLogs[pid].frequency[i] * 1000);

			if(i == playerLogs[pid].frequency.length - 1)
				logToolTip.attr('title', currentText + '<br>' + currentDate.toDateTimeStringNice() + '</center></div>');
			else
				logToolTip.attr('title', currentText + '<br>' + currentDate.toDateTimeStringNice());
		}

	}

	table.appendRow().appendToCell(-1, 'player-names', friends[pid].name).appendToCell(-1, 'total-received', logToolTip);
	if(timeUntilSesReady(pid)) {
		console.log('already sent');
		var totalSec = timeUntilSesReady(pid);
		var hours = parseInt( totalSec / 3600 ) % 24;
		var minutes = parseInt( totalSec / 60 ) % 60;
		var formattedTime = $('<a>').attr('title', '<div><b>Time remaining until you can send</b></div>').text(hours + 'h' + minutes + 'm');
		table.appendToCell(-1, 'send-links', formattedTime);
	} else {
		console.log('ready');
		table.appendToCell(-1, 'send-links', generateSendLink(pid));
	}
};


function openWindow() {
	processLogs(false).then(function () {
		var players = [];
		$.each(friends, function(pid) {
			players.push({ 'id' : pid, 'timeUntilReady' : timeUntilSesReady(pid) });
		});
		function compare(a,b) {
		  if (a.timeUntilReady < b.timeUntilReady)
		    return -1;
		  else if (a.timeUntilReady > b.timeUntilReady)
		    return 1;
		  else 
		    return 0;
		}
		players.sort(compare);
		var windowContent = new west.gui.Scrollpane();
		var friendsTable = new west.gui.Table();
		friendsTable.addColumn('player-names').appendToCell('head', 'player-names', '<img src="//westzzs.innogamescdn.com/images/icons/user.png" alt="" />&nbsp;' + 'Name');
		friendsTable.addColumn('send-links');
		friendsTable.addColumn('total-received');
		for(var i = 0; i < players.length; i++)
			appendPlayerToTable(friendsTable, players[i].id);
		windowContent.appendContent(friendsTable.divMain);
		wman.open('twbf').setTitle('TW Best Friends').appendToContentPane(windowContent.divMain).setMiniTitle('TW Best Friends - Sending currency made easier!').setSize('400', '400');
	});
}

// Right, here's the fun part.

//Manually adding some styling for the table
var styling = $('<style></style>').text('.send-links { float:right; margin-right:5px; } ');
$('head').append(styling);

function initialiseButton() {
	//Generating an icon so you can open the window
	var icon = $('<div></div>').attr({
		'title': 'TW Best Friends',
		'class': 'menulink'
	}).css({
		'background': 'url(https://puu.sh/nkN3l/aba1b474e5.png)',
		'background-position': '0px 0px'
	}).mouseleave(function () {
		$(this).css("background-position", "0px 0px");
	}).mouseenter(function (e) {
		$(this).css("background-position", "25px 0px");
	}).click(openWindow);

	//Generating the end of the button
	var fix = $('<div></div>').attr({
		'class': 'menucontainer_bottom'
	});

	//Adding it
	$("#ui_menubar .ui_menucontainer :last").after($('<div></div>').attr({
		'class': 'ui_menucontainer',
		'id': 'twbf'
	}).append(icon).append(fix));
}

initialiseScript();
