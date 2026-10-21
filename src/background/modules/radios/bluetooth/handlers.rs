use seelen_core::{
    handlers::SeelenEvent,
    system_state::{BluetoothDevice, DevicePairingAnswer, DevicePairingNeededAction},
};
use windows::Devices::Enumeration::{DevicePairingResultStatus, DeviceUnpairingResultStatus};

use crate::{
    app::emit_to_webviews, error::Result, modules::radios::bluetooth::manager::BluetoothManager,
};

fn get_bluetooth_manager() -> &'static BluetoothManager {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        BluetoothManager::subscribe(|_e| {
            emit_to_webviews(
                SeelenEvent::BluetoothDevicesChanged,
                BluetoothManager::instance().get_all_devices(),
            );
        });
    });
    BluetoothManager::instance()
}

impl crate::tauri_handlers::Handlers {
    pub async fn get_bluetooth_devices() -> Result<Vec<BluetoothDevice>> {
        // The first call initializes both WinRT device watchers, which block until their
        // initial enumeration completes. Keep that off the async command workers.
        crate::get_tokio_handle()
            .spawn_blocking(|| get_bluetooth_manager().get_all_devices())
            .await
            .map_err(|err| format!("Failed to read bluetooth devices: {err}").into())
    }

    pub async fn start_bluetooth_scanning() -> Result<()> {
        crate::get_tokio_handle()
            .spawn_blocking(|| get_bluetooth_manager().start_scanning())
            .await
            .map_err(|err| format!("Failed to start Bluetooth scanning: {err}"))?
    }

    pub async fn stop_bluetooth_scanning() -> Result<()> {
        crate::get_tokio_handle()
            .spawn_blocking(|| get_bluetooth_manager().stop_scanning())
            .await
            .map_err(|err| format!("Failed to stop Bluetooth scanning: {err}"))?
    }

    pub async fn request_pair_bluetooth_device(id: String) -> Result<DevicePairingNeededAction> {
        let manager = get_bluetooth_manager();
        manager.request_pair_device(&id).await
    }

    pub async fn confirm_bluetooth_device_pairing(
        id: String,
        answer: DevicePairingAnswer,
    ) -> Result<()> {
        let expected_status = if answer.accept {
            DevicePairingResultStatus::Paired
        } else {
            DevicePairingResultStatus::RejectedByHandler
        };

        let manager = get_bluetooth_manager();
        let status = manager.confirm_device_pairing(&id, answer).await?;

        if status != expected_status {
            return Err(
                format!("Pairing action was not successful! Current status: {status:?}").into(),
            );
        }
        Ok(())
    }

    pub fn disconnect_bluetooth_device(id: String) -> Result<()> {
        let manager = get_bluetooth_manager();
        manager.disconnect_device(&id)
    }

    pub fn connect_bluetooth_device(id: String) -> Result<()> {
        let manager = get_bluetooth_manager();
        manager.connect_device(&id)
    }

    pub async fn forget_bluetooth_device(id: String) -> Result<()> {
        let manager = get_bluetooth_manager();
        let device = if let Some(classic) = manager.devices.get(&id, |d| d.raw.clone()) {
            classic.DeviceInformation()?
        } else if let Some(le) = manager.le_devices.get(&id, |d| d.raw.clone()) {
            le.DeviceInformation()?
        } else {
            return Ok(());
        };

        let status = device.Pairing()?.UnpairAsync()?.await?.Status()?;
        if status == DeviceUnpairingResultStatus::AccessDenied
            || status == DeviceUnpairingResultStatus::Failed
        {
            return Err("Unpair was not succesfull!".into());
        }
        Ok(())
    }
}
