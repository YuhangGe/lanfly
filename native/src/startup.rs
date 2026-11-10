use std::sync::Mutex;

/// Only a successful initialization is permanent; permission failures can be retried.
pub struct RetryOnce(Mutex<bool>);
impl RetryOnce {
    pub const fn new() -> Self {
        Self(Mutex::new(false))
    }
    pub fn initialize(&self, start: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut started = self.0.lock().unwrap();
        if !*started {
            start()?;
            *started = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn retries_after_permission_is_granted_and_keeps_the_successful_thread() {
        let startup = RetryOnce::new();
        assert!(
            startup
                .initialize(|| Err("INPUT_PERMISSION".into()))
                .is_err()
        );
        assert!(startup.initialize(|| Ok(())).is_ok());
        startup
            .initialize(|| panic!("must reuse the running thread"))
            .unwrap();
    }

    #[test]
    fn concurrent_starts_create_only_one_thread() {
        let startup = Arc::new(RetryOnce::new());
        let count = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let startup = startup.clone();
                let count = count.clone();
                std::thread::spawn(move || {
                    startup
                        .initialize(|| {
                            count.fetch_add(1, Ordering::SeqCst);
                            Ok(())
                        })
                        .unwrap()
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
