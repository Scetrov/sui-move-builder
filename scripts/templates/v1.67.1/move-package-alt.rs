
pub mod flavor {
    pub struct Vanilla;
    impl Vanilla {
        pub fn default_environment() -> Self { Self }
    }
    pub mod vanilla {
        pub fn default_environment() -> super::Vanilla { super::Vanilla }
    }
}

pub use flavor::Vanilla;
