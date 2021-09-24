import * as settings from '../../util/settings';
import logger from '../../util/logger';
// @ts-ignore
import zigbeeHerdsmanConverters from 'zigbee-herdsman-converters';
import * as utils from '../../util/utils';
import assert from 'assert';
import Extension from '../extension';
// @ts-ignore
import stringify from 'json-stable-stringify-without-jsonify';
import bind from 'bind-decorator';

const configRegex =
    new RegExp(`${settings.get().mqtt.base_topic}/bridge/config/((?:\\w+/get)|(?:\\w+/factory_reset)|(?:\\w+))`);
const allowedLogLevels = ['error', 'warn', 'info', 'debug'];

class BridgeLegacy extends Extension {
    private lastJoinedDeviceName: string = null;
    private supportedOptions: {[s: string]: (topic: string, message: string) => Promise<void> | void};

    override async start(): Promise<void> {
        this.supportedOptions = {
            'permit_join': this.permitJoin,
            'last_seen': this.lastSeen,
            'elapsed': this.elapsed,
            'reset': this.reset,
            'log_level': this.logLevel,
            'devices': this.devices,
            'groups': this.groups,
            'devices/get': this.devices,
            'rename': this.rename,
            'rename_last': this.renameLast,
            'remove': this.remove,
            'force_remove': this.forceRemove,
            'ban': this.ban,
            'device_options': this.deviceOptions,
            'add_group': this.addGroup,
            'remove_group': this.removeGroup,
            'force_remove_group': this.removeGroup,
            'whitelist': this.whitelist,
            'touchlink/factory_reset': this.touchlinkFactoryReset,
        };

        this.eventBus.onDeviceJoined(this, (data) => this.onZigbeeEvent_('deviceJoined', data, data.device));
        this.eventBus.onDeviceInterview(this, (data) => this.onZigbeeEvent_('deviceInterview', data, data.device));
        this.eventBus.onDeviceAnnounce(this, (data) => this.onZigbeeEvent_('deviceAnnounce', data, data.device));
        this.eventBus.onDeviceLeave(this, (data) => this.onZigbeeEvent_('deviceLeave', data, null));
        this.eventBus.onMQTTMessage(this, this.onMQTTMessage_);

        await this.publish();
    }

    @bind whitelist(topic: string, message: string): void {
        try {
            const entity = settings.getEntity(message);
            assert(entity, `Entity '${message}' does not exist`);
            settings.whitelistDevice(entity.ID.toString());
            logger.info(`Whitelisted '${entity.friendlyName}'`);
            this.mqtt.publish(
                'bridge/log',
                stringify({type: 'device_whitelisted', message: {friendly_name: entity.friendlyName}}),
            );
        } catch (error) {
            logger.error(`Failed to whitelist '${message}' '${error}'`);
        }
    }

    @bind deviceOptions(topic: string, message: string): void {
        let json = null;
        try {
            json = JSON.parse(message);
        } catch (e) {
            logger.error('Failed to parse message as JSON');
            return;
        }

        if (!json.hasOwnProperty('friendly_name') || !json.hasOwnProperty('options')) {
            logger.error('Invalid JSON message, should contain "friendly_name" and "options"');
            return;
        }

        const entity = settings.getEntity(json.friendly_name);
        assert(entity, `Entity '${json.friendly_name}' does not exist`);
        settings.changeEntityOptions(entity.ID.toString(), json.options);
        logger.info(`Changed device specific options of '${json.friendly_name}' (${stringify(json.options)})`);
    }

    @bind async permitJoin(topic: string, message: string): Promise<void> {
        await this.zigbee.permitJoin(message.toLowerCase() === 'true');
        this.publish();
    }

    @bind async reset(): Promise<void> {
        try {
            await this.zigbee.reset('soft');
            logger.info('Soft resetted ZNP');
        } catch (error) {
            logger.error('Soft reset failed');
        }
    }

    @bind lastSeen(topic: string, message: string): void {
        const allowed = ['disable', 'ISO_8601', 'epoch', 'ISO_8601_local'];
        if (!allowed.includes(message)) {
            logger.error(`${message} is not an allowed value, possible: ${allowed}`);
            return;
        }

        settings.set(['advanced', 'last_seen'], message);
        logger.info(`Set last_seen to ${message}`);
    }

    @bind elapsed(topic: string, message: string): void {
        const allowed = ['true', 'false'];
        if (!allowed.includes(message)) {
            logger.error(`${message} is not an allowed value, possible: ${allowed}`);
            return;
        }

        settings.set(['advanced', 'elapsed'], message === 'true');
        logger.info(`Set elapsed to ${message}`);
    }

    @bind logLevel(topic: string, message: string): void {
        const level = message.toLowerCase();
        if (allowedLogLevels.includes(level)) {
            logger.info(`Switching log level to '${level}'`);
            // @ts-ignore
            logger.setLevel(level);
        } else {
            logger.error(`Could not set log level to '${level}'. Allowed level: '${allowedLogLevels.join(',')}'`);
        }

        this.publish();
    }

    @bind async devices(topic: string): Promise<void> {
        const coordinator = await this.zigbee.getCoordinatorVersion();
        const devices = this.zigbee.getDevices().map((device) => {
            const payload: KeyValue = {
                ieeeAddr: device.ieeeAddr,
                type: device.type,
                networkAddress: device.networkAddress,
            };

            if (device.type !== 'Coordinator') {
                const definition = zigbeeHerdsmanConverters.findByDevice(device.zhDevice);
                const friendlyDevice = settings.getDevice(device.ieeeAddr);
                payload.model = definition ? definition.model : device.modelID;
                payload.vendor = definition ? definition.vendor : '-';
                payload.description = definition ? definition.description : '-';
                payload.friendly_name = friendlyDevice ? device.name : device.ieeeAddr;
                payload.manufacturerID = device.zhDevice.manufacturerID;
                payload.manufacturerName = device.manufacturerName;
                payload.powerSource = device.powerSource;
                payload.modelID = device.modelID;
                payload.hardwareVersion = device.zhDevice.hardwareVersion;
                payload.softwareBuildID = device.softwareBuildID;
                payload.dateCode = device.dateCode;
                payload.lastSeen = device.lastSeen;
            } else {
                payload.friendly_name = 'Coordinator';
                payload.softwareBuildID = coordinator.type;
                payload.dateCode = coordinator.meta.revision.toString();
                payload.lastSeen = Date.now();
            }

            return payload;
        });

        if (topic.split('/').pop() == 'get') {
            this.mqtt.publish(
                `bridge/config/devices`, stringify(devices), {}, settings.get().mqtt.base_topic, false, false,
            );
        } else {
            this.mqtt.publish('bridge/log', stringify({type: 'devices', message: devices}));
        }
    }

    @bind groups(): void {
        const payload = settings.getGroups().map((g) => {
            const group = {...g};
            delete group.friendlyName;
            return group;
        });

        this.mqtt.publish('bridge/log', stringify({type: 'groups', message: payload}));
    }

    @bind rename(topic: string, message: string): void {
        const invalid =
            `Invalid rename message format expected {"old": "friendly_name", "new": "new_name"} got ${message}`;

        let json = null;
        try {
            json = JSON.parse(message);
        } catch (e) {
            logger.error(invalid);
            return;
        }

        // Validate message
        if (!json.new || !json.old) {
            logger.error(invalid);
            return;
        }

        this._renameInternal(json.old, json.new);
    }

    @bind renameLast(topic: string, message: string): void {
        if (!this.lastJoinedDeviceName) {
            logger.error(`Cannot rename last joined device, no device has joined during this session`);
            return;
        }

        this._renameInternal(this.lastJoinedDeviceName, message);
    }

    _renameInternal(from: string, to: string): void {
        try {
            const isGroup = settings.getGroup(from) !== null;
            settings.changeFriendlyName(from, to);
            logger.info(`Successfully renamed - ${from} to ${to} `);
            const entity = this.zigbee.resolveEntity(to);
            const eventData = utils.isGroup(entity) ? {group: entity.zhGroup, homeAssisantRename: false} :
                {device: entity.zhDevice, from, to, homeAssisantRename: false};
            this.eventBus.emit(`${isGroup ? 'group' : 'device'}Renamed`, eventData);

            this.mqtt.publish(
                'bridge/log',
                stringify({type: `${isGroup ? 'group' : 'device'}_renamed`, message: {from, to}}),
            );
        } catch (error) {
            logger.error(`Failed to rename - ${from} to ${to}`);
        }
    }

    @bind addGroup(topic: string, message: string): void {
        let id = null;
        let name = null;
        try {
            // json payload with id and friendly_name
            const json = JSON.parse(message);
            if (json.hasOwnProperty('id')) {
                id = json.id;
                name = `group_${id}`;
            }
            if (json.hasOwnProperty('friendly_name')) {
                name = json.friendly_name;
            }
        } catch (e) {
            // just friendly_name
            name = message;
        }

        if (name == null) {
            logger.error('Failed to add group, missing friendly_name!');
            return;
        }

        const group = settings.addGroup(name, id);
        this.zigbee.createGroup(group.ID);
        this.mqtt.publish('bridge/log', stringify({type: `group_added`, message: name}));
        logger.info(`Added group '${name}'`);
    }

    @bind removeGroup(topic: string, message: string): void {
        const name = message;
        const entity = this.zigbee.resolveEntity(message) as Group;
        assert(entity && utils.isGroup(entity), `Group '${message}' does not exist`);

        if (topic.includes('force')) {
            entity.zhGroup.removeFromDatabase();
        } else {
            entity.zhGroup.removeFromNetwork();
        }
        settings.removeGroup(message);

        this.mqtt.publish('bridge/log', stringify({type: `group_removed`, message}));
        logger.info(`Removed group '${name}'`);
    }

    @bind async forceRemove(topic: string, message: string): Promise<void> {
        await this.removeForceRemoveOrBan('force_remove', message);
    }

    @bind async remove(topic: string, message: string): Promise<void> {
        await this.removeForceRemoveOrBan('remove', message);
    }

    @bind async ban(topic: string, message: string): Promise<void> {
        await this.removeForceRemoveOrBan('ban', message);
    }

    @bind async removeForceRemoveOrBan(action: string, message: string): Promise<void> {
        const entity = this.zigbee.resolveEntity(message.trim()) as Device;
        const lookup: KeyValue = {
            ban: ['banned', 'Banning', 'ban'],
            force_remove: ['force_removed', 'Force removing', 'force remove'],
            remove: ['removed', 'Removing', 'remove'],
        };

        if (!entity) {
            logger.error(`Cannot ${lookup[action][2]}, device '${message}' does not exist`);

            this.mqtt.publish('bridge/log', stringify({type: `device_${lookup[action][0]}_failed`, message}));
            return;
        }

        const cleanup = (): void => {
            // Fire event
            this.eventBus.emit('deviceRemoved', {resolvedEntity: entity});

            // Remove from configuration.yaml
            settings.removeDevice(entity.ieeeAddr);

            // Remove from state
            this.state.remove(entity.ieeeAddr);

            logger.info(`Successfully ${lookup[action][0]} ${entity.settings.friendlyName}`);
            this.mqtt.publish('bridge/log', stringify({type: `device_${lookup[action][0]}`, message}));
        };

        const ieeeAddr = entity.ieeeAddr;

        try {
            logger.info(`${lookup[action][1]} '${entity.settings.friendlyName}'`);
            if (action === 'force_remove') {
                await entity.zhDevice.removeFromDatabase();
            } else {
                await entity.zhDevice.removeFromNetwork();
            }

            cleanup();
        } catch (error) {
            logger.error(`Failed to ${lookup[action][2]} ${entity.settings.friendlyName} (${error})`);
            // eslint-disable-next-line
            logger.error(`See https://www.zigbee2mqtt.io/information/mqtt_topics_and_message_structure.html#zigbee2mqttbridgeconfigremove for more info`);

            this.mqtt.publish('bridge/log', stringify({type: `device_${lookup[action][0]}_failed`, message}));
        }

        if (action === 'ban') {
            settings.banDevice(ieeeAddr);
        }
    }

    @bind async onMQTTMessage_(data: EventMQTTMessage): Promise<void> {
        const {topic, message} = data;
        if (!topic.match(configRegex)) {
            return;
        }

        const option = topic.match(configRegex)[1];

        if (!this.supportedOptions.hasOwnProperty(option)) {
            return;
        }

        await this.supportedOptions[option](topic, message);

        return;
    }

    async publish(): Promise<void> {
        const info = await utils.getZigbee2MQTTVersion();
        const coordinator = await this.zigbee.getCoordinatorVersion();
        const topic = `bridge/config`;
        const payload = {
            version: info.version,
            commit: info.commitHash,
            coordinator,
            network: await this.zigbee.getNetworkParameters(),
            // @ts-ignore
            log_level: logger.getLevel(),
            permit_join: this.zigbee.getPermitJoin(),
        };

        await this.mqtt.publish(topic, stringify(payload), {retain: true, qos: 0});
    }

    onZigbeeEvent_(type: string, data: KeyValue, resolvedEntity: Device): void {
        if (type === 'deviceJoined' && resolvedEntity) {
            this.lastJoinedDeviceName = resolvedEntity.name;
        }

        if (type === 'deviceJoined') {
            this.mqtt.publish(
                'bridge/log',
                stringify({type: `device_connected`, message: {friendly_name: resolvedEntity.name}}),
            );
        } else if (type === 'deviceInterview') {
            if (data.status === 'successful') {
                if (resolvedEntity.definition) {
                    const {vendor, description, model} = resolvedEntity.definition;
                    const log = {friendly_name: resolvedEntity.name, model, vendor, description, supported: true};
                    this.mqtt.publish(
                        'bridge/log',
                        stringify({type: `pairing`, message: 'interview_successful', meta: log}),
                    );
                } else {
                    const meta = {friendly_name: resolvedEntity.name, supported: false};
                    this.mqtt.publish(
                        'bridge/log',
                        stringify({type: `pairing`, message: 'interview_successful', meta}),
                    );
                }
            } else if (data.status === 'failed') {
                const meta = {friendly_name: resolvedEntity.name};
                this.mqtt.publish(
                    'bridge/log',
                    stringify({type: `pairing`, message: 'interview_failed', meta}),
                );
            } else {
                /* istanbul ignore else */
                if (data.status === 'started') {
                    const meta = {friendly_name: resolvedEntity.name};
                    this.mqtt.publish(
                        'bridge/log',
                        stringify({type: `pairing`, message: 'interview_started', meta}),
                    );
                }
            }
        } else if (type === 'deviceAnnounce') {
            const meta = {friendly_name: resolvedEntity.name};
            this.mqtt.publish('bridge/log', stringify({type: `device_announced`, message: 'announce', meta}));
        } else {
            /* istanbul ignore else */
            if (type === 'deviceLeave') {
                const name = data.ieeeAddr;
                const meta = {friendly_name: name};
                this.mqtt.publish(
                    'bridge/log',
                    stringify({type: `device_removed`, message: 'left_network', meta}),
                );
            }
        }
    }

    @bind async touchlinkFactoryReset(): Promise<void> {
        logger.info('Starting touchlink factory reset...');
        this.mqtt.publish(
            'bridge/log',
            stringify({type: `touchlink`, message: 'reset_started', meta: {status: 'started'}}),
        );
        const result = await this.zigbee.touchlinkFactoryResetFirst();

        if (result) {
            logger.info('Successfully factory reset device through Touchlink');
            this.mqtt.publish(
                'bridge/log',
                stringify({type: `touchlink`, message: 'reset_success', meta: {status: 'success'}}),
            );
        } else {
            logger.warn('Failed to factory reset device through Touchlink');
            this.mqtt.publish(
                'bridge/log',
                stringify({type: `touchlink`, message: 'reset_failed', meta: {status: 'failed'}}),
            );
        }
    }
}

module.exports = BridgeLegacy;
