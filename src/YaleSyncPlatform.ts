import { YaleApiClient } from './yale/YaleApiClient';
import { platformConfigDecoder } from './YaleSyncPlatformConfig';
import { Logger } from './yale/Logger';
import { ContactSensor, MotionSensor, Panel, MotionSensorState, ContactSensorState } from './yale/YaleModels';
import { modeToCurrentState, targetStateToString, targetStateToMode, currentStateToString } from './YaleSyncHelpers';
import wait from './Wait';
import { API, DynamicPlatformPlugin, Logger as HBLogger, PlatformConfig, PlatformAccessory as HBPlatformAccessory, CharacteristicValue, CharacteristicGetCallback, CharacteristicSetCallback } from 'homebridge';


const pluginName = 'homebridge-yalesyncalarm';
const platformName = 'YaleSyncAlarm';

class YaleSyncPlatform implements DynamicPlatformPlugin {

		constructor(log: HBLogger, config: PlatformConfig, api: API) {
			this._log = log;
			this._config = config;
			this._api = api;
			this.Service = api.hap.Service;
			this.Characteristic = api.hap.Characteristic;
			this.PlatformAccessory = api.platformAccessory;
			this.UUIDGenerator = api.hap.uuid;

			// Decode config and initialize YaleApiClient
			try {
				const decodedConfig = platformConfigDecoder.decodeAny(config);
				this._yale = new YaleApiClient(decodedConfig.username, decodedConfig.password);
			} catch (e) {
				this._log.error('Invalid configuration:', e);
				return;
			}

			// Restore cached accessories
			api.on('didFinishLaunching', () => {
				this._log.info('Homebridge platform didFinishLaunching, starting discovery/heartbeat');
				// Start periodic discovery/heartbeat
				const interval = typeof config.refreshInterval === 'number' ? config.refreshInterval : 10;
				this.heartbeat(interval).catch(err => this._log.error('Heartbeat error:', err));
			});
		}
	private _yale?: YaleApiClient;
	private _accessories: { [key: string]: any } = {};
	private readonly _log!: HBLogger;
	private readonly _api!: API;
	private readonly _config!: PlatformConfig;
	private Service: any;
	private Characteristic: any;
	private UUIDGenerator: any;
	private PlatformAccessory: any;

	configureAccessory(accessory: HBPlatformAccessory): void {
		// Required by Homebridge v2 platform interface
		// Store or restore accessory as needed
		this._accessories[accessory.UUID] = accessory;
	}

	async heartbeat(interval: number) {
		if (!this._yale) return;
		while (true) {
		try {
		// Fetch latest panel and sensors
		const panel: Panel = await this._yale.getPanel();
		const sensors: (MotionSensor | ContactSensor)[] = await this._yale.getSensors();
		// Build lookup maps for sensors
		const motionSensors: { [id: string]: MotionSensor } = {};
		const contactSensors: { [id: string]: ContactSensor } = {};
		const newAccessories: any[] = [];

		// Register panel accessory if missing
		const panelUUID = this.UUIDGenerator.generate(panel.identifier);
		if (!this._accessories[panelUUID]) {
			const panelAccessory = new this.PlatformAccessory(panel.name, panelUUID);
			panelAccessory.context = { kind: 'panel', identifier: panel.identifier };
			this.configurePanel(panelAccessory);
			newAccessories.push(panelAccessory);
			this._log.info(`Registering new panel accessory: ${panel.name}`);
		}

		for (const sensor of sensors) {
			if ('state' in sensor && Object.values(MotionSensorState).includes((sensor as any).state)) {
				motionSensors[sensor.identifier] = sensor as MotionSensor;
				// Register motion sensor accessory if missing
				const uuid = this.UUIDGenerator.generate(sensor.identifier);
				if (!this._accessories[uuid]) {
					const motionAccessory = new this.PlatformAccessory(sensor.name, uuid);
					motionAccessory.context = { kind: 'motionSensor', identifier: sensor.identifier };
					this.configureMotionSensor(motionAccessory);
					newAccessories.push(motionAccessory);
					this._log.info(`Registering new motion sensor accessory: ${sensor.name}`);
				}
			} else if ('state' in sensor && Object.values(ContactSensorState).includes((sensor as any).state)) {
				contactSensors[sensor.identifier] = sensor as ContactSensor;
				// Register contact sensor accessory if missing
				const uuid = this.UUIDGenerator.generate(sensor.identifier);
				if (!this._accessories[uuid]) {
					const contactAccessory = new this.PlatformAccessory(sensor.name, uuid);
					contactAccessory.context = { kind: 'contactSensor', identifier: sensor.identifier };
					this.configureContactSensor(contactAccessory);
					newAccessories.push(contactAccessory);
					this._log.info(`Registering new contact sensor accessory: ${sensor.name}`);
				}
			}
		}

		// Register all new accessories with Homebridge
		if (newAccessories.length > 0) {
			this._api.registerPlatformAccessories(pluginName, platformName, newAccessories);
		}

		// Update values for all known accessories
		for (const [uuid, acc] of Object.entries(this._accessories)) {
			const accessory = acc as any;
			if (accessory.context.kind === 'panel' && panel !== undefined) {
				if (accessory.context.identifier === panel.identifier) {
					accessory
						.getService(this.Service.SecuritySystem)
						.getCharacteristic(this.Characteristic.SecuritySystemCurrentState)
						?.setValue(modeToCurrentState(this.Characteristic, panel.state), undefined, 'no_recurse');
				}
			} else if (accessory.context.kind === 'motionSensor') {
				const motionSensor = motionSensors[accessory.context.identifier];
				if (motionSensor) {
					accessory
						.getService(this.Service.MotionSensor)
						.getCharacteristic(this.Characteristic.MotionDetected)
						?.setValue(
							motionSensor.state === MotionSensorState.Triggered ? true : false,
							undefined,
							'no_recurse'
						);
				}
			} else if (accessory.context.kind === 'contactSensor') {
				const contactSensor = contactSensors[accessory.context.identifier];
				if (contactSensor) {
					accessory
						.getService(this.Service.ContactSensor)
						.getCharacteristic(this.Characteristic.ContactSensorState)
						?.setValue(
							contactSensor.state === ContactSensorState.Closed ? 0 : 1,
							undefined,
							'no_recurse'
						);
				}
			}
		}
		} catch (err) {
			this._log.error('Heartbeat error (will retry):', err);
		}
		await wait(interval * 1000);
		} // end while
	}

	public configureContactSensor(accessory: any): void {
		if (this._yale === undefined) {
			return;
		}
		if (this._accessories[accessory.UUID] === undefined) {
			const informationService: any = accessory.getService(this.Service.AccessoryInformation);
			informationService
				.setCharacteristic(this.Characteristic.Name, accessory.displayName)
				.setCharacteristic(this.Characteristic.Manufacturer, 'Yale')
				.setCharacteristic(this.Characteristic.Model, 'Contact Sensor')
				.setCharacteristic(this.Characteristic.SerialNumber, accessory.context.identifier);
			const sensorService: any =
				accessory.getService(this.Service.ContactSensor) !== undefined
					? accessory.getService(this.Service.ContactSensor)
					: accessory.addService(this.Service.ContactSensor);
			sensorService
				.getCharacteristic(this.Characteristic.ContactSensorState)
				.on('get' as any, async (callback: CharacteristicGetCallback) => {
					if (this._yale === undefined) {
						callback(new Error(`${pluginName} incorrectly configured`));
						return;
					}
					const sensors = await this._yale.getSensors();
					const contactSensor = sensors.find(s => s.identifier === accessory.context.identifier && 'state' in s && Object.values(ContactSensorState).includes((s as any).state)) as ContactSensor | undefined;
					if (contactSensor !== undefined) {
						this._log.info(`Fetching status of contact sensor: ${contactSensor.name} ${contactSensor.identifier}`);
						callback(null, contactSensor.state === ContactSensorState.Closed ? 0 : 1);
					} else {
						callback(new Error(`Contact sensor: ${accessory.context.identifier} not found`));
					}
				});
			this._accessories[accessory.UUID] = accessory;
		}
	}

	public configureMotionSensor(accessory: any): void {
		if (this._yale === undefined) {
			// Incorrectly configured plugin.
			return;
		}
		if (this._accessories[accessory.UUID] === undefined) {
			const informationService: any = accessory.getService(this.Service.AccessoryInformation);
			informationService
				.setCharacteristic(this.Characteristic.Name, accessory.displayName)
				.setCharacteristic(this.Characteristic.Manufacturer, 'Yale')
				.setCharacteristic(this.Characteristic.Model, 'Motion Sensor')
				.setCharacteristic(this.Characteristic.SerialNumber, accessory.context.identifier);
			const sensorService: any =
				accessory.getService(this.Service.MotionSensor) !== undefined
					? accessory.getService(this.Service.MotionSensor)
					: accessory.addService(this.Service.MotionSensor);
			sensorService
				.getCharacteristic(this.Characteristic.MotionDetected)
				.on('get' as any, async (callback: CharacteristicGetCallback) => {
					if (this._yale === undefined) {
						callback(new Error(`${pluginName} incorrectly configured`));
						return;
					}
					const sensors = await this._yale.getSensors();
					const motionSensor = sensors.find(s => s.identifier === accessory.context.identifier && Object.values(MotionSensorState).includes((s as any).state)) as MotionSensor | undefined;
					if (motionSensor !== undefined) {
						this._log.info(`Fetching status of motion sensor: ${motionSensor.name} ${motionSensor.identifier}`);
						callback(null, motionSensor.state === MotionSensorState.Triggered);
					} else {
						callback(new Error(`Motion sensor: ${accessory.context.identifier} not found`));
					}
				});
			this._accessories[accessory.UUID] = accessory;
		}
	}

	public configurePanel(accessory: any): void {
		if (this._yale === undefined) {
			// Incorrectly configured plugin.
			return;
		}
		if (this._accessories[accessory.UUID] === undefined) {
			const informationService: any = accessory.getService(this.Service.AccessoryInformation);
			informationService
				.setCharacteristic(this.Characteristic.Name, accessory.displayName)
				.setCharacteristic(this.Characteristic.Manufacturer, 'Yale')
				.setCharacteristic(this.Characteristic.Model, 'Yale IA-320')
				.setCharacteristic(this.Characteristic.SerialNumber, accessory.context.identifier);
			const securitySystem: any =
				accessory.getService(this.Service.SecuritySystem) !== undefined
					? accessory.getService(this.Service.SecuritySystem)
					: accessory.addService(this.Service.SecuritySystem);
			securitySystem
				.getCharacteristic(this.Characteristic.SecuritySystemCurrentState)
				.on('get' as any, async (callback: CharacteristicGetCallback) => {
					if (this._yale === undefined) {
						callback(new Error(`${pluginName} incorrectly configured`));
						return;
					}
					this._log.info(`Fetching panel state`);
					let panel = await this._yale.getPanel();
					let panelState = modeToCurrentState(this.Characteristic, panel.state);
					this._log.info(`Panel mode: ${panel.state}, HomeKit state: ${currentStateToString(this.Characteristic, panelState)}`);
					callback(null, panelState);
				});
			securitySystem
				.getCharacteristic(this.Characteristic.SecuritySystemTargetState)
				.on('get' as any, async (callback: CharacteristicGetCallback) => {
					if (this._yale === undefined) {
						callback(new Error(`${pluginName} incorrectly configured`));
						return;
					}
					let panel = await this._yale.getPanel();
					callback(null, modeToCurrentState(this.Characteristic, panel.state));
				})
				.on('set' as any, async (targetState: CharacteristicValue, callback: CharacteristicSetCallback, context?: any) => {
					if (this._yale === undefined) {
						callback(new Error(`${pluginName} incorrectly configured`));
						return;
					}
					if (context !== 'no_recurse') {
						callback();
						const mode = await this._yale.setPanelState(targetStateToMode(this.Characteristic, targetState));
						this._log.info(`Panel mode: ${mode.state}, HomeKit state: ${currentStateToString(this.Characteristic, modeToCurrentState(this.Characteristic, mode.state))}`);
						securitySystem.getCharacteristic(this.Characteristic.SecuritySystemCurrentState)?.updateValue(modeToCurrentState(this.Characteristic, mode.state));
					}
				});
			this._accessories[accessory.UUID] = accessory;
		}
	}
}

export default YaleSyncPlatform;

