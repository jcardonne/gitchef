use serde::{Serialize, Serializer};

/// One error type for the whole backend. Serializes to a plain string so the
/// React side always receives a readable message from a rejected `invoke`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Msg(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
