jellyfishClient = function(config) {
    var tidepoolServer = config.tidepoolServer;
    var deviceInfo = null;
    var setDeviceInfo = function(info) {
        deviceInfo = _.pick(info, 'deviceId', 'source', 'timezoneOffset', 'units');
    };

    var buildBG = function (bg, timestamp, devicetime) {
        var bgRec = _.assign({}, deviceInfo, {
            type: 'smbg',
            value: bg,
            time: timestamp,
            deviceTime: devicetime
        });

        return bgRec;
    };

    // this doesn't actually exist yet
    var buildNote = function (note, timestamp, devicetime) {
        var noteRec = _.assign({}, deviceInfo, {
            type: 'note',
            value: note,
            time: timestamp,
            deviceTime: devicetime
        });

        return noteRec;
    };

    var buildCarb = function (carbs, timestamp, devicetime) {
        var carbRec = _.assign({}, deviceInfo, {
            type: 'food',
            carbs: carbs,
            time: timestamp,
            deviceTime: devicetime
        });

        return carbRec;
    };

    var buildWizard = function (recommended, bgInput, bolus, payload, timestamp, devicetime) {
        var carbRec = _.assign({}, deviceInfo, {
            type: 'wizard',
            recommended: recommended,
            bgInput: bgInput,
            bolus: bolus,
            payload: payload,
            time: timestamp,
            deviceTime: devicetime
        });

        return carbRec;
    };

    var buildNormalBolus = function (units, timestamp, devicetime) {
        var bolusRec = _.assign({}, deviceInfo, {
            type: 'bolus',
            subType: 'normal',
            normal: units,
            time: timestamp,
            deviceTime: devicetime
        });
        return [bolusRec];
        // var completionRec = _.clone(bolusRec);
        // completionRec.previous = _.clone(bolusRec);
        // return [bolusRec, completionRec];
    };

    var buildSquareBolus = function (units, duration, timestamp, devicetime) {
        var bolusRec = _.assign({}, deviceInfo, {
            type: 'bolus',
            subType: 'square',
            extended: units,
            duration: duration,
            time: timestamp,
            deviceTime: devicetime
        });
        return [bolusRec];
        // var completionRec = _.clone(bolusRec);
        // completionRec.previous = _.clone(bolusRec);
        // return [bolusRec, completionRec];
    };

    var buildDualBolus = function (normalunits, extendedunits, duration, timestamp, devicetime) {
        var bolusRec = _.assign({}, deviceInfo, {
            type: 'bolus',
            subType: 'dual/square',
            normal: normalunits,
            extended: extendedunits,
            duration: duration,
            time: timestamp,
            deviceTime: devicetime
        });
        return [bolusRec];
        // var normalCompletionRec = _.omit(bolusRec, 'extended', 'duration');
        // normalCompletionRec.previous = _.clone(bolusRec);
        // var extendedCompletionRec = _.omit(bolusRec, 'normal');
        // extendedCompletionRec.previous = _.clone(bolusRec);
        // return [bolusRec, normalCompletionRec, extendedCompletionRec];
    };

    var buildScheduledBasal = function(scheduleName, rate, duration_msec, previous, timestamp, devicetime) {
        var basalRec = _.assign({}, deviceInfo,  {
            type: 'basal',
            deliveryType: 'scheduled',
            scheduleName: scheduleName,
            rate: rate,
            duration: duration_msec,
            time: timestamp,
            deviceTime: devicetime
        });
        if (previous != null) {
            basalRec.previous = previous;
        }
        return basalRec;
    };

    var buildSettings = function(activeScheduleName, units, schedules, carbRatio, 
            insulinSensitivity, bgTarget, timestamp, devicetime) {

        var settingsRec = _.assign({}, deviceInfo,  {
            type: 'settings',
            activeSchedule: activeScheduleName,
            units: units,
            basalSchedules: schedules,
            carbRatio: carbRatio,
            insulinSensitivity: insulinSensitivity,
            bgTarget: bgTarget,
            time: timestamp,
            deviceTime: devicetime
        });
        return settingsRec;
    };


    var postOne = function (data, callback) {
        // console.log('poster');
        var recCount = data.length;
        var happy = function(resp, status, jqxhr) {
            // console.log('Jellyfish post succeeded.');
            // console.log(status);
            // console.log(resp);
            callback(null, recCount);
        };
        var sad = function(jqxhr, status, err) {
            if (jqxhr.responseJSON && jqxhr.responseJSON.errorCode && jqxhr.responseJSON.errorCode == 'duplicate') {
                console.log(jqxhr.responseJSON);
                callback('duplicate', jqxhr.responseJSON.index);
            } else {
                console.log('Jellyfish post failed.');
                console.log(status);
                console.log(err);
                console.log(jqxhr);
                callback(err, 0);
            }
        };
        tidepoolServer.postToJellyfish(data, happy, sad);
    };

    // we break up the posts because jellyfish has a 1MB upload limit at one time
    var post = function (data, callback) {
        var blocks = [];
        var BLOCKSIZE = 50;
        for (var i=0; i<data.length; i+=BLOCKSIZE) {
            blocks.push(data.slice(i, i+BLOCKSIZE));
        }
        async.mapSeries(blocks, postOne, callback);
    };


    return {
        setDeviceInfo: setDeviceInfo,
        buildBG: buildBG,
        buildNote: buildNote,
        buildCarb: buildCarb,
        buildWizard: buildWizard,
        buildDualBolus: buildDualBolus,
        buildSquareBolus: buildSquareBolus,
        buildNormalBolus: buildNormalBolus,
        buildScheduledBasal: buildScheduledBasal,
        buildSettings: buildSettings,
        post: post
    };
};