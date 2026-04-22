import { Yale } from 'yalesyncalarm'
import {
	Service as HAPService,
	Categories as HAPAccessoryCategory,
	Characteristic as HAPCharacteristic,
	uuid,
	CharacteristicValue,
	CharacteristicGetCallback,
	CharacteristicSetCallback,
	Nullable,
} from 'hap-nodejs'
import { platformConfigDecoder } from './YaleSyncPlatformConfig'
// Removed invalid import from hap-nodejs/dist/lib/gen/HomeKit
import { Logger, LogLevel } from 'yalesyncalarm/dist/Logger'
import { ContactSensor, MotionSensor, Panel } from 'yalesyncalarm/dist/Model'
import wait from './Wait'

// All of these are redeclared, and then reassigned below so we can elide the require('hap-nodejs').
// This means hap-nodejs can just be a development dependency and we can reduce the package size.
// Typescript 3.8 allows for import type {}, but we don't use that yet.

let Service: typeof HAPService
let Characteristic: typeof HAPCharacteristic
let UUIDGenerator: typeof uuid
// let Categories: typeof HAPAccessoryCategory // Not needed for runtime

let PlatformAccessory: any

let pluginName = 'homebridge-yalesyncalarm'
let platformName = 'YaleSyncAlarm'

export default function (homebridge: any) {
       Service = homebridge.hap.Service;
       Characteristic = homebridge.hap.Characteristic;
       UUIDGenerator = homebridge.hap.uuid;
	// Categories assignment removed; not needed for runtime

       PlatformAccessory = homebridge.platformAccessory;

       homebridge.registerPlatform(
	       pluginName,
	       platformName,
			   (log: any, config: any, api: any) => new YaleSyncPlatform(log, config, api),
	       true // dynamic
       );
}

function modeToCurrentState(mode: Panel.State) {
	switch (mode) {
		case Panel.State.Armed:
			return Characteristic.SecuritySystemCurrentState.AWAY_ARM
		case Panel.State.Disarmed:
			return Characteristic.SecuritySystemCurrentState.DISARMED
		case Panel.State.Home:
			// HomeKit also exposes STAY_ARM. Yale doesn't distinguish between the concepts of "STAY_ARM" and "NIGHT_ARM"
			// So we just arbitrarily always choose to map "home" <> NIGHT_ARM.
			return Characteristic.SecuritySystemCurrentState.NIGHT_ARM
	}
}

function targetStateToString(state: CharacteristicValue) {
	if (state === Characteristic.SecuritySystemTargetState.STAY_ARM) {
		return 'home'
	} else if (state === Characteristic.SecuritySystemTargetState.AWAY_ARM) {
		return 'away'
	} else if (state === Characteristic.SecuritySystemTargetState.NIGHT_ARM) {
		return 'night'
	} else if (state === Characteristic.SecuritySystemTargetState.DISARM) {
		return 'off'
	}
}

function currentStateToString(state: CharacteristicValue) {
	if (state === Characteristic.SecuritySystemCurrentState.STAY_ARM) {
		return 'home'
	} else if (state === Characteristic.SecuritySystemCurrentState.AWAY_ARM) {
		return 'away'
	} else if (state === Characteristic.SecuritySystemCurrentState.NIGHT_ARM) {
		return 'night'
	} else if (state === Characteristic.SecuritySystemCurrentState.DISARMED) {
		return 'off'
	} else if (
		state === Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED
	) {
		return 'triggered'
	}
}

function targetStateToMode(targetState: CharacteristicValue): Panel.State {
	if (targetState === Characteristic.SecuritySystemTargetState.AWAY_ARM) {
		return Panel.State.Armed
	} else if (targetState === Characteristic.SecuritySystemTargetState.DISARM) {
		return Panel.State.Disarmed
	} else {
		// .STAY_ARM || .NIGHT_ARM
		return Panel.State.Home
	}
}

class YaleSyncPlatform {
	private _yale?: Yale
	private _accessories: { [key: string]: any } = {}

	constructor(
		private readonly _log: any,
		config: any,
		private readonly _api: any
	) {
		// Validate the config, if we're not correctly configured, the rest of the plugin
		// fails gracefully instead of crashing homebridge.
		try {
			const platformConfig = platformConfigDecoder.decodeAny(config)
			this._yale = new Yale(
				platformConfig.username,
				platformConfig.password,
				new Logger(LogLevel.Info | LogLevel.Error, this._log)
			)
			this._api.on('didFinishLaunching', async () => {
				await this.onDidFinishLaunching()
				const refreshInterval = platformConfig.refreshInterval
				if (refreshInterval >= 1) {
					this._log(
						`Refresh interval is ${refreshInterval} seconds, starting periodic updates`
					)
					this.heartbeat(refreshInterval)
				} else {
					this._log(`Refresh interval is < 1 second, periodic updates disabled`)
				}
			})
		} catch (error) {
			this._log((error as Error).message)
		}
	}

	async heartbeat(interval: number) {
		if (this._yale === undefined) {
			return
		}
		await wait(interval * 1000)
		await this._yale.update()
		const [panel, motionSensors, contactSensors] = await Promise.all([
			await this._yale.panel(),
			await this._yale.motionSensors(),
			await this._yale.contactSensors(),
		])
		for (let [uuid, accessory] of Object.entries(this._accessories)) {
			if (accessory.context.kind === 'panel' && panel !== undefined) {
				if (accessory.identifier === panel.identifier) {
					accessory
						.getService(Service.SecuritySystem)
						.getCharacteristic(Characteristic.SecuritySystemCurrentState)
						?.setValue(modeToCurrentState(panel.state), undefined, 'no_recurse')
				}
			} else if (accessory.context.kind === 'motionSensor') {
				const motionSensor = motionSensors[accessory.context.identifier]
				if (motionSensor) {
					accessory
						.getService(Service.MotionSensor)
						.getCharacteristic(Characteristic.MotionDetected)
						?.setValue(
							motionSensor.state === MotionSensor.State.Triggered ? true : false,
							undefined,
							'no_recurse'
						)
				}
			} else if (accessory.context.kind === 'contactSensor') {
				const contactSensor = contactSensors[accessory.context.identifier]
				if (contactSensor) {
					accessory
						.getService(Service.ContactSensor)
						.getCharacteristic(Characteristic.ContactSensorState)
						?.setValue(
							contactSensor.state === ContactSensor.State.Closed
								? 0 // ContactSensorState.CONTACT_DETECTED
								: 1, // ContactSensorState.CONTACT_NOT_DETECTED
							undefined,
							'no_recurse'
						)
				}
			}
		}
		this.heartbeat(interval)
	}

	// Called when homebridge has finished loading cached accessories.
	// We need to register new ones and unregister ones that are no longer reachable.
	async onDidFinishLaunching() {
		if (this._yale === undefined) {
			// Incorrectly configured plugin.
			return
		}
		this._log('Searching for devices')
		await this._yale.update()

		const panel = await this._yale.panel()
		if (panel !== undefined) {
			this._log(`Discovered panel: ${panel.identifier}`)
			const uuid = UUIDGenerator.generate(
				`${pluginName}.${platformName}.panel.${panel.identifier}`
			)
			if (this._accessories[uuid] === undefined) {
				       const accessory = new PlatformAccessory(
					       'Alarm System',
					       uuid,
					       11 // SECURITY_SYSTEM
				       )
				accessory.context.identifier = panel.identifier
				accessory.context.kind = 'panel'
				this.configurePanel(accessory)
				this._log(`Registering alarm panel: ${panel.identifier}`)
				this._api.registerPlatformAccessories(pluginName, platformName, [
					accessory,
				])
			} else {
				this._log(
					`Panel: ${panel.identifier} already registered with Homebridge`
				)
			}
		}

		const motionSensors = await this._yale.motionSensors()
		for (let [identifier, motionSensor] of Object.entries(motionSensors)) {
			this._log(
				   `Discovered moton sensor: ${(motionSensor as MotionSensor).name}, ${(motionSensor as MotionSensor).identifier}`
			)
			const uuid = UUIDGenerator.generate(
				`${pluginName}.${platformName}.motionSensor.${identifier}`
			)
			if (this._accessories[uuid] === undefined) {
				       const accessory = new PlatformAccessory(
					       (motionSensor as MotionSensor).name,
					    uuid,
					    10 // SENSOR
				       )
				accessory.context.identifier = identifier
				accessory.context.kind = 'motionSensor'
				this.configureMotionSensor(accessory)
				this._log(
					   `Registering motion sensor: ${(motionSensor as MotionSensor).name} ${(motionSensor as MotionSensor).identifier}`
				)
				this._api.registerPlatformAccessories(pluginName, platformName, [
					accessory,
				])
			} else {
				this._log(
					   `Motion sensor: ${(motionSensor as MotionSensor).name} ${(motionSensor as MotionSensor).identifier} already registered with Homebridge`
				)
			}
		}

		const contactSensors = await this._yale.contactSensors()
		for (let [identifier, contactSensor] of Object.entries(contactSensors)) {
			this._log(
				   `Discovered moton sensor: ${(contactSensor as ContactSensor).name} ${(contactSensor as ContactSensor).identifier}`
			)
			const uuid = UUIDGenerator.generate(
				`${pluginName}.${platformName}.contactSensor.${identifier}`
			)
			if (this._accessories[uuid] === undefined) {
				       const accessory = new PlatformAccessory(
					       (contactSensor as ContactSensor).name,
					    uuid,
					    10 // SENSOR
				       )
				accessory.context.identifier = identifier
				accessory.context.kind = 'contactSensor'
				this.configureContactSensor(accessory)
				this._log(
					   `Registering contact sensor: ${(contactSensor as ContactSensor).name} ${(contactSensor as ContactSensor).identifier}`
				)
				this._api.registerPlatformAccessories(pluginName, platformName, [
					accessory,
				])
			} else {
				this._log(
					   `Contact sensor: ${(contactSensor as ContactSensor).name} ${(contactSensor as ContactSensor).identifier} already registered with Homebridge`
				)
			}
		}
	}

	// Called when homebridge restores a cached accessory.
	configureAccessory(accessory: any) {
		if (this._yale === undefined) {
			// Incorrectly configured plugin.
			return
		}
		if (this._accessories[accessory.UUID] === undefined) {
			if (accessory.context.kind === 'panel') {
				this.configurePanel(accessory)
			} else if (accessory.context.kind === 'motionSensor') {
				this.configureMotionSensor(accessory)
			} else if (accessory.context.kind === 'contactSensor') {
				this.configureContactSensor(accessory)
			}
		}
	}

	configureMotionSensor(accessory: any) {
		if (this._yale === undefined) {
			// Incorrectly configured plugin.
			return
		}
		if (this._accessories[accessory.UUID] === undefined) {
			// Homebridge adds this service by default to all instances of PlatformAccessory
			   const informationService: any = accessory.getService(
				Service.AccessoryInformation
			)
			informationService
				       .setCharacteristic(Characteristic.Name, accessory.displayName)
				       .setCharacteristic(Characteristic.Manufacturer, 'Yale')
				       .setCharacteristic(Characteristic.Model, 'Motion Sensor')
				       .setCharacteristic(
					       Characteristic.SerialNumber,
					       accessory.context.identifier
				       )
			       const sensorService: any =
				       accessory.getService(Service.MotionSensor) !== undefined
					       ? accessory.getService(Service.MotionSensor)
					       : accessory.addService(Service.MotionSensor)
			sensorService
				.getCharacteristic(Characteristic.MotionDetected)
				       .on(
					       'get' as any,
					       async (
						       callback: CharacteristicGetCallback,
						       context?: any,
						       connectionID?: string | undefined
					       ) => {
						if (this._yale === undefined) {
							callback(new Error(`${pluginName} incorrectly configured`))
							return
						}
						const motionSensors = await this._yale.motionSensors()
						const motionSensor = motionSensors[accessory.context.identifier]
						if (motionSensor !== undefined) {
							this._log(
								`Fetching status of motion sensor: ${motionSensor.name} ${motionSensor.identifier}`
							)

							callback(null, false)

							const updated = await this._yale.updateMotionSensor(motionSensor)
							if (updated !== undefined) {
								this._log(
									`Motion sensor: ${motionSensor.name} ${motionSensor.identifier
									}, state: ${updated.state === MotionSensor.State.Triggered
										? 'triggered'
										: 'none detected'
									}`
								)

								sensorService
									.getCharacteristic(Characteristic.MotionDetected)?.updateValue(updated.state === MotionSensor.State.Triggered ? true : false)

							} else {
								callback(
									new Error(
										`Failed to get status of motion sensor: ${motionSensor.name} ${motionSensor.identifier}`
									)
								)
							}
						} else {
							callback(
								new Error(
									`Motion sensor: ${accessory.context.identifier} not found`
								)
							)
						}
					}
				)
		}
		// updateReachability is removed in Homebridge v2.0
		this._accessories[accessory.UUID] = accessory
	}

	configureContactSensor(accessory: any) {
		if (this._yale === undefined) {
			// Incorrectly configured plugin.
			return
		}
		if (this._accessories[accessory.UUID] === undefined) {
			// Homebridge adds this service by default to all instances of PlatformAccessory
			const informationService: any = accessory.getService(
				Service.AccessoryInformation
			)
			informationService
				.setCharacteristic(Characteristic.Name, accessory.displayName)
				.setCharacteristic(Characteristic.Manufacturer, 'Yale')
				.setCharacteristic(Characteristic.Model, 'Contact Sensor')
				.setCharacteristic(
					Characteristic.SerialNumber,
					accessory.context.identifier
				)
			const sensorService: any =
				accessory.getService(Service.ContactSensor) !== undefined
					? accessory.getService(Service.ContactSensor)
					: accessory.addService(Service.ContactSensor)
			sensorService
				.getCharacteristic(Characteristic.ContactSensorState)
				       .on(
					       'get' as any,
					       async (
						       callback: CharacteristicGetCallback,
						       context?: any,
						       connectionID?: string | undefined
					       ) => {
						if (this._yale === undefined) {
							callback(new Error(`${pluginName} incorrectly configured`))
							return
						}
						const contactSensors = await this._yale.contactSensors()
						const contactSensor = contactSensors[accessory.context.identifier]
						if (contactSensor !== undefined) {
							this._log(
								`Fetching status of contact sensor: ${contactSensor.name} ${contactSensor.identifier}`
							)


							callback(null, 0)

							const updated = await this._yale.updateContactSensor(
								contactSensor
							)
							if (updated !== undefined) {
								this._log(
									`Contact sensor: ${contactSensor.name} ${contactSensor.identifier
									}, state: ${updated.state === ContactSensor.State.Closed
										? 'closed'
										: 'open'
									}`
								)

								sensorService
									.getCharacteristic(Characteristic.ContactSensorState)?.updateValue(updated.state === ContactSensor.State.Closed
										? 0 : 1)
							} else {
								callback(
									new Error(
										`Failed to get status of contact sensor: ${contactSensor.name} ${contactSensor.identifier}`
									)
								)
							}
						} else {
							callback(
								new Error(
									`Contact sensor: ${accessory.context.identifier} not found`
								)
							)
						}
					}
				)
		}
		// updateReachability is removed in Homebridge v2.0
		this._accessories[accessory.UUID] = accessory
	}

	configurePanel(accessory: any) {
		if (this._yale === undefined) {
			// Incorrectly configured plugin.
			return
		}
		if (this._accessories[accessory.UUID] === undefined) {
			// Homebridge adds this service by default to all instances of PlatformAccessory
			const informationService: any = accessory.getService(
				Service.AccessoryInformation
			)
			informationService
				.setCharacteristic(Characteristic.Name, accessory.displayName)
				.setCharacteristic(Characteristic.Manufacturer, 'Yale')
				.setCharacteristic(Characteristic.Model, 'Yale IA-320')
				.setCharacteristic(
					Characteristic.SerialNumber,
					accessory.context.identifier
				)

			const securitySystem: any =
				accessory.getService(Service.SecuritySystem) !== undefined
					? accessory.getService(Service.SecuritySystem)
					: accessory.addService(Service.SecuritySystem)
			securitySystem
				.getCharacteristic(Characteristic.SecuritySystemCurrentState)
				       .on(
					       'get' as any,
					       async (
						       callback: CharacteristicGetCallback,
						       context?: any,
						       connectionID?: string | undefined
					       ) => {
						if (this._yale === undefined) {
							// Incorrectly configured plugin.
							callback(new Error(`${pluginName} incorrectly configured`))
							return
						}
						this._log(`Fetching panel state`)
						let panelMode = await this._yale.getPanelState()
						let panelState = modeToCurrentState(panelMode)
						this._log(
							`Panel mode: ${panelMode}, HomeKit state: ${currentStateToString(
								panelState
							)}`
						)
						callback(null, panelState)
					}
				)

			securitySystem
				.getCharacteristic(Characteristic.SecuritySystemTargetState)
				       .on(
					       'get' as any,
					       async (
						       callback: CharacteristicGetCallback,
						       context?: any,
						       connectionID?: string | undefined
					       ) => {
						if (this._yale === undefined) {
							// Incorrectly configured plugin.
							callback(new Error(`${pluginName} incorrectly configured`))
							return
						}
						let panelState = await this._yale.getPanelState()
						callback(null, modeToCurrentState(panelState))
					}
				)
				?.on(
					'set' as any,
					async (
						targetState: CharacteristicValue,
						callback: CharacteristicSetCallback,
						context?: any,
						connectionID?: string | undefined
					) => {
						if (this._yale === undefined) {
							// Incorrectly configured plugin.
							callback(new Error(`${pluginName} incorrectly configured`))
							return
						}
						if (context !== 'no_recurse') {

							callback()

							const mode = await this._yale.setPanelState(
								targetStateToMode(targetState)
							)
							this._log(
								`Panel mode: ${mode}, HomeKit state: ${currentStateToString(
									modeToCurrentState(mode)
								)}`
							)
							securitySystem.getCharacteristic(
								Characteristic.SecuritySystemCurrentState
							)?.updateValue(
								modeToCurrentState(mode))
						}
					}
				)
			// updateReachability is removed in Homebridge v2.0
			this._accessories[accessory.UUID] = accessory
		}
	}
}
